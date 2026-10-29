import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { apply, TOOL_NAMES } from '../lib/tools.js';
import { appendTimeline, auditPath, createLedger, readLedger, resolveRoot, solutionPath, writeLedger } from '../lib/store.js';
import { digest } from '../lib/canonical.js';
import { loadMatrix } from '../lib/matrix.js';
import { normalizeContract, validateContract } from '../lib/contract.js';
import { buildBundle, defaultEnvironment, readBundle } from '../lib/audit.js';
import { normalizeSolution } from '../lib/evidence.js';
import {
  answerOnlySolution,
  callTool,
  makeContract,
  makeExec,
  makeManualEvidence,
  makeSolution,
  makeTempDir,
  makeToolCtx,
} from './helpers.js';

function setup(role = 'full') {
  const temp = makeTempDir('proteus-sec-');
  const { ctx, tools, logs } = makeToolCtx();
  apply(ctx, { role, root: 'proteus', evidenceMinKinds: 2, targetAttempts: 5 });
  const exec = makeExec(temp.dir);
  return { temp, tools, logs, exec, rootDir: resolveRoot(temp.dir, 'proteus') };
}

function numericIds(evidence) {
  return evidence.filter((item) => item.kind === 'numeric').map((item) => item.evidence_id);
}

async function createVerifiedContract(env) {
  const created = await callTool(env.tools, 'proteus_contract', { action: 'create', contract: makeContract() }, env.exec);
  assert.equal(created.ok, true);
  const run = await callTool(env.tools, 'proteus_verify', {
    action: 'run',
    contract_id: created.contract_id,
    solution: answerOnlySolution('2'),
  }, env.exec);
  return { contractId: created.contract_id, run, ids: numericIds(run.evidence) };
}

function mutateLedger(env, contractId, mutate) {
  const ledger = readLedger(env.rootDir, contractId);
  mutate(ledger);
  writeLedger(env.rootDir, ledger);
}

const FINALIZE_ENVS = [
  {
    name: '改 kind',
    mutate(ledger) {
      const record = ledger.evidence.find((item) => item.kind === 'numeric');
      record.kind = 'symbolic';
    },
  },
  {
    name: '改 status',
    mutate(ledger) {
      const record = ledger.evidence.find((item) => item.kind === 'numeric');
      record.status = 'fail';
    },
  },
  {
    name: '改 evidence_id',
    mutate(ledger) {
      const record = ledger.evidence.find((item) => item.kind === 'numeric');
      record.evidence_id = 'ev_000000000000';
    },
  },
  {
    name: '删证据',
    mutate(ledger) {
      const record = ledger.evidence.find((item) => item.kind === 'numeric');
      ledger.evidence = ledger.evidence.filter((item) => item.evidence_id !== record.evidence_id);
    },
  },
];

for (const scenario of FINALIZE_ENVS) {
  test(`security B1：${scenario.name}后 finalize 不得 Verified，audit verify 必须失败`, async () => {
    const env = setup();
    try {
      const { contractId, ids } = await createVerifiedContract(env);
      mutateLedger(env, contractId, scenario.mutate);
      const solution = makeSolution({ symbolic: ids[0], numeric: ids[0] });
      const finalized = await callTool(env.tools, 'proteus_finalize', { contract_id: contractId, solution }, env.exec);
      assert.equal(finalized.ok, true);
      assert.notEqual(finalized.state, 'Verified');
      assert.ok(finalized.reason_codes.includes('EVIDENCE_CONFLICT'));
      const audit = await callTool(env.tools, 'proteus_audit', { action: 'verify', contract_id: contractId }, env.exec);
      assert.equal(audit.ok, false);
    } finally {
      env.temp.cleanup();
    }
  });
}

test('security B1：悬空 evidence_refs → finalize EVIDENCE_CONFLICT', async () => {
  const env = setup();
  try {
    const { contractId, ids } = await createVerifiedContract(env);
    const solution = makeSolution({ symbolic: ids[0], numeric: ids[0] });
    solution.steps[2].evidence_refs = ['ev_deadbeef0000'];
    const finalized = await callTool(env.tools, 'proteus_finalize', { contract_id: contractId, solution }, env.exec);
    assert.equal(finalized.ok, true);
    assert.notEqual(finalized.state, 'Verified');
    assert.ok(finalized.reason_codes.includes('EVIDENCE_CONFLICT'));
    assert.ok(finalized.evidence_issues.some((item) => item.code === 'DANGLING_EVIDENCE_REF'));
  } finally {
    env.temp.cleanup();
  }
});

test('security B2：伪造 state/grade 并重算 bundle_id 后 verify/replay 必须失败', async () => {
  const env = setup();
  try {
    const { contractId, ids } = await createVerifiedContract(env);
    const finalized = await callTool(env.tools, 'proteus_finalize', {
      contract_id: contractId,
      solution: makeSolution({ symbolic: ids[0], numeric: ids[0] }),
    }, env.exec);
    assert.equal(finalized.ok, true);
    const original = JSON.parse(readFileSync(finalized.audit_path, 'utf8'));
    const auditDir = join(env.rootDir, 'audit');

    const forge = (mutate) => {
      const forged = structuredClone(original);
      mutate(forged);
      forged.bundle_id = digest((() => {
        const { bundle_id: _ignored, ...rest } = forged;
        return rest;
      })());
      const file = join(auditDir, `forged-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(forged));
      return file;
    };

    const forgedState = forge((bundle) => {
      bundle.state.state = 'Verified';
      bundle.state.reason_codes = [];
    });
    const stateVerify = await callTool(env.tools, 'proteus_audit', { action: 'verify', bundle_path: forgedState }, env.exec);
    assert.equal(stateVerify.ok, false);
    assert.ok(stateVerify.issues.some((item) => item.code === 'STATE_MISMATCH'));
    const stateReplay = await callTool(env.tools, 'proteus_audit', { action: 'replay', bundle_path: forgedState }, env.exec);
    assert.equal(stateReplay.ok, false);
    assert.ok(stateReplay.diffs.some((diff) => diff.kind === 'state'));

    const forgedGrade = forge((bundle) => {
      bundle.grade.predicted_points = bundle.grade.max_points;
    });
    const gradeVerify = await callTool(env.tools, 'proteus_audit', { action: 'verify', bundle_path: forgedGrade }, env.exec);
    assert.equal(gradeVerify.ok, false);
    assert.ok(gradeVerify.issues.some((item) => item.code === 'GRADE_MISMATCH'));

    const forgedReplay = await callTool(env.tools, 'proteus_audit', { action: 'replay', bundle_path: forgedGrade }, env.exec);
    assert.equal(forgedReplay.ok, false);
    assert.ok(forgedReplay.diffs.some((diff) => diff.kind === 'grade'));
  } finally {
    env.temp.cleanup();
  }
});

test('security B2：无效契约自洽包 verify 失败', async () => {
  const env = setup();
  try {
    const invalidRaw = makeContract({ domain: 'astrology' });
    const contract = normalizeContract(invalidRaw);
    assert.equal(validateContract(contract).state, 'invalid');
    const ledger = createLedger(contract);
    appendTimeline(ledger, 'contract.created', '2026-01-01T00:00:00.000Z');
    const bundle = buildBundle({ ledger, environment: defaultEnvironment(contract), at: '2026-01-01T00:00:00.000Z' });
    const file = join(env.rootDir, 'audit', 'invalid-contract.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(bundle));
    const result = await callTool(env.tools, 'proteus_audit', { action: 'verify', bundle_path: file }, env.exec);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((item) => item.code === 'INVALID_CONTRACT'));
  } finally {
    env.temp.cleanup();
  }
});

test('security M1：旧 fail 不污染修正后的答案', async () => {
  const env = setup();
  try {
    const created = await callTool(env.tools, 'proteus_contract', { action: 'create', contract: makeContract() }, env.exec);
    const contractId = created.contract_id;
    const first = await callTool(env.tools, 'proteus_verify', {
      action: 'run', contract_id: contractId, solution: answerOnlySolution('3'),
    }, env.exec);
    assert.ok(first.evidence.some((item) => item.status === 'fail'));
    const second = await callTool(env.tools, 'proteus_verify', {
      action: 'run', contract_id: contractId, solution: answerOnlySolution('2'),
    }, env.exec);
    assert.equal(second.attempt, 2);
    const ids = numericIds(second.evidence);
    const finalized = await callTool(env.tools, 'proteus_finalize', {
      contract_id: contractId,
      solution: makeSolution({ symbolic: ids[0], numeric: ids[0] }),
    }, env.exec);
    assert.equal(finalized.ok, true);
    assert.equal(finalized.reason_codes.includes('EVIDENCE_CONFLICT'), false);
    assert.equal(finalized.evidence_summary.fail, 0);
    assert.equal(finalized.evidence_summary.total, 4);
    const bundle = readBundle(finalized.audit_path);
    assert.equal(bundle.evidence.length, 4);
    assert.equal(bundle.verification.attempt, 2);
  } finally {
    env.temp.cleanup();
  }
});

test('security M2：重复 finalize 幂等/拒绝，矩阵不重复计数', async () => {
  const env = setup();
  try {
    const { contractId, ids } = await createVerifiedContract(env);
    const solution = makeSolution({ symbolic: ids[0], numeric: ids[0] });
    const first = await callTool(env.tools, 'proteus_finalize', { contract_id: contractId, solution }, env.exec);
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);

    const second = await callTool(env.tools, 'proteus_finalize', { contract_id: contractId, solution }, env.exec);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.audit_path, first.audit_path);

    const matrix = loadMatrix(env.rootDir);
    const cell = Object.values(matrix.cells)[0];
    assert.equal(cell.attempts, 1);

    const different = await callTool(env.tools, 'proteus_finalize', {
      contract_id: contractId,
      solution: { ...solution, answer: { value: '9' } },
    }, env.exec);
    assert.equal(different.ok, false);
    assert.equal(different.error.code, 'ALREADY_FINALIZED');
    assert.equal(Object.values(loadMatrix(env.rootDir).cells)[0].attempts, 1);
  } finally {
    env.temp.cleanup();
  }
});

test('security M3：矩阵写失败 → finalize 失败且 ledger 不置 finalized', async () => {
  const env = setup();
  try {
    const { contractId, ids } = await createVerifiedContract(env);
    mkdirSync(join(env.rootDir, 'matrix.json'), { recursive: true });
    const finalized = await callTool(env.tools, 'proteus_finalize', {
      contract_id: contractId,
      solution: makeSolution({ symbolic: ids[0], numeric: ids[0] }),
    }, env.exec);
    assert.equal(finalized.ok, false);
    assert.equal(finalized.error.code, 'MATRIX_WRITE_FAILED');
    assert.notEqual(readLedger(env.rootDir, contractId).state, 'finalized');
    assert.equal(existsSync(solutionPath(env.rootDir, contractId)), false, '失败时不得写 solution');
    assert.equal(existsSync(auditPath(env.rootDir, contractId)), false, '失败时不得写 audit bundle');
  } finally {
    env.temp.cleanup();
  }
});

test('security M4：checks 子集 + seed 覆盖可 verify/replay', async () => {
  const env = setup();
  try {
    const created = await callTool(env.tools, 'proteus_contract', { action: 'create', contract: makeContract() }, env.exec);
    const contractId = created.contract_id;
    const run = await callTool(env.tools, 'proteus_verify', {
      action: 'run',
      contract_id: contractId,
      checks: ['answer_format', 'numeric_residual'],
      seed: 7,
      solution: answerOnlySolution('2'),
    }, env.exec);
    assert.deepEqual(run.plan, ['answer_format', 'numeric_residual']);
    assert.equal(run.evidence.length, 2);
    const ids = numericIds(run.evidence);
    const solution = makeSolution({ symbolic: ids[0], numeric: ids[0] });
    const finalized = await callTool(env.tools, 'proteus_finalize', { contract_id: contractId, solution }, env.exec);
    assert.equal(finalized.ok, true);
    const bundle = readBundle(finalized.audit_path);
    assert.deepEqual(bundle.verification.plan, ['answer_format', 'numeric_residual']);
    assert.equal(bundle.verification.seed, 7);
    assert.equal(bundle.environment.seed, 7);
    const verified = await callTool(env.tools, 'proteus_audit', { action: 'verify', contract_id: contractId }, env.exec);
    assert.equal(verified.ok, true);
    const replay = await callTool(env.tools, 'proteus_audit', { action: 'replay', contract_id: contractId }, env.exec);
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.plan, ['answer_format', 'numeric_residual']);
    assert.equal(replay.seed, 7);
  } finally {
    env.temp.cleanup();
  }
});

test('security M6/M11：renderer 每步标证据种类，bundle 含 finalize.completed 与 budget.phase', async () => {
  const env = setup();
  try {
    const { contractId, ids } = await createVerifiedContract(env);
    await callTool(env.tools, 'proteus_budget', { action: 'start', contract_id: contractId }, env.exec);
    const finalized = await callTool(env.tools, 'proteus_finalize', {
      contract_id: contractId,
      solution: makeSolution({ symbolic: ids[0], numeric: ids[0] }),
    }, env.exec);
    const markdown = readFileSync(finalized.solution_path, 'utf8');
    for (const block of ['## 契约摘要', '## 题目', '## 答案', '## 步骤', '## 评分预测', '## 验证状态', '## 陷阱检查', '## 证据', '## 审计']) {
      assert.ok(markdown.includes(block), `缺少区块 ${block}`);
    }
    assert.ok(markdown.includes('### S1（2/2）〔structural〕'));
    assert.ok(markdown.includes('### S2（1.5/3）〔heuristic〕'));
    assert.ok(markdown.includes('### S3（3/3）〔numeric〕'));

    const bundle = readBundle(finalized.audit_path);
    assert.ok(bundle.timeline.some((entry) => entry.event === 'finalize.completed'));
    assert.equal(bundle.budget.phase, 'explore');
    assert.ok(bundle.budget.check);

    const rewritten = await callTool(env.tools, 'proteus_audit', { action: 'write', contract_id: contractId }, env.exec);
    assert.equal(rewritten.existing, true);
    assert.equal(rewritten.bundle_id, bundle.bundle_id);
  } finally {
    env.temp.cleanup();
  }
});

test('security M15：budget 二次 start 拒绝，restart 记录事件', async () => {
  const env = setup();
  try {
    const created = await callTool(env.tools, 'proteus_contract', { action: 'create', contract: makeContract() }, env.exec);
    const contractId = created.contract_id;
    assert.equal((await callTool(env.tools, 'proteus_budget', { action: 'start', contract_id: contractId }, env.exec)).ok, true);
    const duplicate = await callTool(env.tools, 'proteus_budget', { action: 'start', contract_id: contractId }, env.exec);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error.code, 'BUDGET_ALREADY_STARTED');
    const restarted = await callTool(env.tools, 'proteus_budget', { action: 'start', contract_id: contractId, restart: true }, env.exec);
    assert.equal(restarted.ok, true);
    assert.equal(restarted.restarted, true);
    const ledger = readLedger(env.rootDir, contractId);
    assert.ok(ledger.timeline.some((entry) => entry.event === 'budget.restarted'));
  } finally {
    env.temp.cleanup();
  }
});

test('security M9：cwd 越界与 bundle_path 越界都返回 PATH_DENIED', async () => {
  const env = setup();
  try {
    const outside = dirname(env.temp.dir);
    const denied = await callTool(env.tools, 'proteus_contract', {
      action: 'create', contract: makeContract(), cwd: outside,
    }, env.exec);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'PATH_DENIED');

    const created = await callTool(env.tools, 'proteus_contract', { action: 'create', contract: makeContract() }, env.exec);
    const outsideBundle = await callTool(env.tools, 'proteus_audit', {
      action: 'verify', bundle_path: join(env.temp.dir, 'evil.json'),
    }, env.exec);
    assert.equal(outsideBundle.ok, false);
    assert.equal(outsideBundle.error.code, 'PATH_DENIED');

    const subCwd = join(env.temp.dir, 'sub');
    const subCreated = await callTool(env.tools, 'proteus_contract', {
      action: 'create', contract: makeContract(), cwd: 'sub',
    }, env.exec);
    assert.equal(subCreated.ok, true);
    assert.ok(readLedger(resolveRoot(subCwd, 'proteus'), subCreated.contract_id) !== null);
    assert.equal(readLedger(env.rootDir, created.contract_id) !== null, true);
  } finally {
    env.temp.cleanup();
  }
});

test('security：ROLE_ACTIONS 与最终工具数一致（auditor 无写账本工具）', () => {
  assert.equal(TOOL_NAMES.length, 7);
  assert.equal(TOOL_NAMES.includes('proteus_verify'), true);
  assert.equal(makeManualEvidence().kind, 'human');
});

test('security R1：不能信任 bundle.environment.evidence_min_kinds', async () => {
  const env = setup();
  try {
    const { contractId, ids } = await createVerifiedContract(env);
    const finalized = await callTool(env.tools, 'proteus_finalize', {
      contract_id: contractId,
      solution: makeSolution({ symbolic: ids[0], numeric: ids[0] }),
    }, env.exec);
    assert.equal(finalized.state, 'LowConfidence');
    const bundle = JSON.parse(readFileSync(finalized.audit_path, 'utf8'));
    const forged = structuredClone(bundle);
    forged.environment.evidence_min_kinds = 1;
    forged.state.state = 'Verified';
    forged.state.reason_codes = [];
    forged.bundle_id = digest((() => {
      const { bundle_id: _ignored, ...rest } = forged;
      return rest;
    })());
    const file = join(env.rootDir, 'audit', 'forged-min-kinds.json');
    writeFileSync(file, JSON.stringify(forged));

    const verified = await callTool(env.tools, 'proteus_audit', { action: 'verify', bundle_path: file }, env.exec);
    assert.equal(verified.ok, false);
    assert.ok(verified.issues.some((item) => item.code === 'CONFIG_MISMATCH'));
    assert.ok(verified.issues.some((item) => item.code === 'STATE_MISMATCH'));

    const replay = await callTool(env.tools, 'proteus_audit', { action: 'replay', bundle_path: file }, env.exec);
    assert.equal(replay.ok, false);
  } finally {
    env.temp.cleanup();
  }
});

test('security R2：cwd 符号链接逃逸 → PATH_DENIED', async (t) => {
  const env = setup();
  const outside = makeTempDir('proteus-outside-');
  try {
    try {
      symlinkSync(outside.dir, join(env.temp.dir, 'link'), 'dir');
    } catch {
      t.skip('当前平台/权限不支持创建 symlink');
      return;
    }
    const denied = await callTool(env.tools, 'proteus_contract', {
      action: 'create', contract: makeContract(), cwd: 'link',
    }, env.exec);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'PATH_DENIED');

    // 合法子目录仍允许
    const allowed = await callTool(env.tools, 'proteus_contract', {
      action: 'create', contract: makeContract(), cwd: 'inside',
    }, env.exec);
    assert.equal(allowed.ok, true);
  } finally {
    outside.cleanup();
    env.temp.cleanup();
  }
});

test('security R5：answer.unit 省略与 null 等价（证据 id / 重复 finalize）', async () => {
  const env = setup();
  try {
    assert.deepEqual(
      normalizeSolution({ answer: { value: '2' } }),
      normalizeSolution({ answer: { value: '2', unit: null } }),
    );
    const { contractId, ids } = await createVerifiedContract(env);
    const solution = makeSolution({ symbolic: ids[0], numeric: ids[0] });
    solution.answer = { value: '2' }; // 省略 unit
    const first = await callTool(env.tools, 'proteus_finalize', { contract_id: contractId, solution }, env.exec);
    assert.equal(first.ok, true);
    assert.equal(first.reason_codes.includes('EVIDENCE_CONFLICT'), false);
    assert.equal(first.reason_codes.includes('EVIDENCE_INSUFFICIENT'), true);

    const second = await callTool(env.tools, 'proteus_finalize', {
      contract_id: contractId,
      solution: makeSolution({ symbolic: ids[0], numeric: ids[0] }),
    }, env.exec);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
  } finally {
    env.temp.cleanup();
  }
});
