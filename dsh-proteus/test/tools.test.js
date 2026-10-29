import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { apply, buildPromptSection, decideFinalState, ROLE_ACTIONS, TOOL_NAMES } from '../lib/tools.js';
import { auditPath, readLedger, resolveRoot, solutionPath, writeLedger } from '../lib/store.js';
import { validateContract } from '../lib/contract.js';
import {
  answerOnlySolution,
  callTool,
  findTool,
  makeContract,
  makeExec,
  makeManualEvidence,
  makeSolution,
  makeTempDir,
  makeToolCtx,
} from './helpers.js';

function setup(role = 'full') {
  const temp = makeTempDir();
  const { ctx, tools, sections, effects, logs } = makeToolCtx();
  apply(ctx, { role, root: 'proteus', evidenceMinKinds: 2, targetAttempts: 5 });
  const exec = makeExec(temp.dir);
  return { temp, ctx, tools, sections, effects, logs, exec };
}

function numericIdsOf(evidence) {
  return evidence.filter((item) => item.kind === 'numeric').map((item) => item.evidence_id);
}

test('tools：按角色注册物理上不同的工具集', () => {
  const expectations = {
    full: TOOL_NAMES,
    contract: ['proteus_contract', 'proteus_route', 'proteus_budget'],
    solver: ['proteus_contract', 'proteus_route', 'proteus_budget', 'proteus_verify'],
    grader: ['proteus_contract', 'proteus_route', 'proteus_budget', 'proteus_grade'],
    auditor: ['proteus_contract', 'proteus_route', 'proteus_budget', 'proteus_audit'],
  };
  for (const [role, names] of Object.entries(expectations)) {
    const { tools, sections, effects } = setup(role);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...names].sort(), role);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'plugin:proteus-tools');
    assert.equal(sections[0].order, 150);
    assert.ok(sections[0].text.includes(role));
    assert.equal(effects.length, names.length + 1);
  }
  // 未知角色按最保守的 contract 角色处理
  const fallback = setup('does-not-exist');
  assert.deepEqual(fallback.tools.map((tool) => tool.name).sort(), [...expectations.contract].sort());
});

test('tools：定义形状（参数/输出/render）与 INVALID_ACTION', async () => {
  const { tools, exec } = setup('full');
  for (const definition of tools) {
    assert.equal(typeof definition.description, 'string');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.timeoutMs, 'number');
    assert.equal(typeof definition.execute, 'function');
    const blocks = definition.output.render({}, { ok: true });
    assert.deepEqual(blocks[0].type, 'text');
    assert.equal(JSON.parse(blocks[0].text).ok, true);
  }
  const denied = await callTool(tools, 'proteus_contract', { action: 'nope' }, exec);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'INVALID_ACTION');
});

test('tools：全链路 create→route→budget→verify→grade→finalize→audit verify→replay', async () => {
  const { temp, tools, exec } = setup('full');
  try {
    const created = await callTool(tools, 'proteus_contract', { action: 'create', contract: makeContract() }, exec);
    assert.equal(created.ok, true);
    assert.equal(created.state, 'ready');
    assert.equal(created.persisted, true);
    assert.equal(created.next, 'solve');
    assert.equal(created.routing.cell_key, 'gaokao-math|calculus|GK.FUNC.DERIV|computation|medium');
    assert.equal(created.routing.strategy, 'symbolic_first');
    const contractId = created.contract_id;

    const show = await callTool(tools, 'proteus_contract', { action: 'show', contract_id: contractId }, exec);
    assert.equal(show.ok, true);
    assert.equal(show.evidence_count, 0);
    assert.equal(show.state, 'ready');
    assert.equal(show.ledger_state, 'created');

    const lookup = await callTool(tools, 'proteus_route', { action: 'lookup', contract_id: contractId }, exec);
    assert.equal(lookup.ok, true);
    assert.equal(lookup.cell_key, created.routing.cell_key);
    assert.equal(typeof lookup.metrics.priority, 'number');
    assert.equal(lookup.strategy.id, 'symbolic_first');
    assert.ok(Array.isArray(lookup.weak_siblings));

    const stats = await callTool(tools, 'proteus_route', { action: 'stats' }, exec);
    assert.equal(stats.ok, true);
    assert.equal(stats.totals.cells, 0);
    assert.deepEqual(stats.weakest, []);

    const budget = await callTool(tools, 'proteus_budget', { action: 'start', contract_id: contractId }, exec);
    assert.equal(budget.ok, true);
    assert.equal(budget.state.phase, 'explore');
    const check = await callTool(tools, 'proteus_budget', { action: 'check', contract_id: contractId, stage: 'solve' }, exec);
    assert.equal(check.ok, true);
    assert.equal(check.checkpoint.stage, 'solve');
    const status = await callTool(tools, 'proteus_budget', { action: 'status', contract_id: contractId }, exec);
    assert.equal(status.ok, true);
    assert.equal(status.budget.checkpoints.length, 1);

    const plan = await callTool(tools, 'proteus_verify', { action: 'plan', contract_id: contractId }, exec);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.checks.map((item) => item.id), ['answer_format', 'numeric_residual', 'expression_sample', 'domain_probe']);

    const run = await callTool(tools, 'proteus_verify', { action: 'run', contract_id: contractId, solution: answerOnlySolution('2') }, exec);
    assert.equal(run.ok, true);
    assert.equal(run.evidence.length, 4);
    const expressionSample = run.evidence.find((item) => item.check === 'expression_sample');
    assert.equal(expressionSample.kind, 'numeric'); // 采样是数值介质，不是 CAS
    assert.deepEqual(run.independent_kinds, ['numeric']);
    assert.equal(run.summary.pass, 4);
    assert.equal(run.summary.fail, 0);

    const ids = numericIdsOf(run.evidence);
    const solution = makeSolution({ symbolic: ids[0], numeric: ids[0] });
    const graded = await callTool(tools, 'proteus_grade', { contract_id: contractId, solution }, exec);
    assert.equal(graded.ok, true);
    assert.equal(graded.max_points, 12);
    assert.equal(graded.predicted_points, 10.5);
    assert.equal(graded.confidence, 0.83);
    assert.deepEqual(graded.independent_kinds, ['numeric']);
    assert.deepEqual(graded.traps, []);

    const finalized = await callTool(tools, 'proteus_finalize', { contract_id: contractId, solution }, exec);
    assert.equal(finalized.ok, true);
    assert.equal(finalized.state, 'LowConfidence');
    assert.ok(finalized.reason_codes.includes('EVIDENCE_INSUFFICIENT'));
    assert.equal(finalized.predicted_points, 10.5);
    assert.ok(existsSync(finalized.solution_path));
    assert.ok(existsSync(finalized.audit_path));
    const markdown = readFileSync(finalized.solution_path, 'utf8');
    assert.ok(markdown.includes('## 评分预测'));
    assert.ok(markdown.includes('LowConfidence'));
    assert.deepEqual(finalized.warnings, []);

    const verifyAudit = await callTool(tools, 'proteus_audit', { action: 'verify', contract_id: contractId }, exec);
    assert.equal(verifyAudit.ok, true);
    assert.deepEqual(verifyAudit.issues, []);
    assert.match(verifyAudit.bundle_id, /^sha256:/);

    const replay = await callTool(tools, 'proteus_audit', { action: 'replay', contract_id: contractId }, exec);
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.diffs, []);
    assert.equal(replay.checks.length, 4);

    // 篡改 bundle 后 verify 必须失败
    const bundle = JSON.parse(readFileSync(finalized.audit_path, 'utf8'));
    bundle.evidence[0].status = 'fail';
    writeFileSync(finalized.audit_path, JSON.stringify(bundle));
    const tampered = await callTool(tools, 'proteus_audit', { action: 'verify', contract_id: contractId }, exec);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.issues.some((issue) => issue.code === 'EVIDENCE_DIGEST'));
    const tamperedReplay = await callTool(tools, 'proteus_audit', { action: 'replay', contract_id: contractId }, exec);
    assert.equal(tamperedReplay.ok, false);
    assert.equal(tamperedReplay.error.code, 'BUNDLE_INVALID');

    // 矩阵已更新
    const afterStats = await callTool(tools, 'proteus_route', { action: 'stats' }, exec);
    assert.equal(afterStats.totals.cells, 1);
    assert.equal(afterStats.totals.attempts, 1);
    assert.equal(afterStats.totals.low_confidence, 1);
    assert.equal(afterStats.totals.points_earned, 10.5);
  } finally {
    temp.cleanup();
  }
});

test('tools：纯 v0.1 数值证据不能判 Verified；决策函数对 symbolic 适配器开放', async () => {
  const { temp, tools, exec } = setup('full');
  try {
    const created = await callTool(tools, 'proteus_contract', { action: 'create', contract: makeContract() }, exec);
    const contractId = created.contract_id;
    await callTool(tools, 'proteus_budget', { action: 'start', contract_id: contractId }, exec);
    const run = await callTool(tools, 'proteus_verify', { action: 'run', contract_id: contractId, solution: answerOnlySolution('2') }, exec);
    const ids = numericIdsOf(run.evidence);
    const numericOnly = makeSolution({ symbolic: ids[0], numeric: ids[0] });
    const finalized = await callTool(tools, 'proteus_finalize', { contract_id: contractId, solution: numericOnly }, exec);
    assert.equal(finalized.state, 'LowConfidence');
    assert.ok(finalized.reason_codes.includes('EVIDENCE_INSUFFICIENT'));
    assert.notEqual(finalized.state, 'Verified');
    assert.deepEqual(finalized.evidence_summary.independent_kinds, ['numeric']);

    // 终态判定函数本身对未来的 symbolic/formal/human 适配器开放：
    const contract = validateContract(makeContract()).contract;
    const decision = decideFinalState({
      contract,
      solution: makeSolution(),
      evidence: [
        makeManualEvidence({ kind: 'numeric', check: 'numeric_residual' }),
        makeManualEvidence({ kind: 'symbolic', check: 'expression_sample' }),
        makeManualEvidence({ kind: 'structural', check: 'answer_format' }),
      ],
      gradeResult: { traps: [] },
      budgetState: null,
      evidenceMinKinds: 2,
    });
    assert.equal(decision.state, 'Verified');
  } finally {
    temp.cleanup();
  }
});

test('tools：未 verify 时 finalize 拒绝且不产出半成品', async () => {
  const { temp, tools, exec } = setup('full');
  try {
    const created = await callTool(tools, 'proteus_contract', { action: 'create', contract: makeContract() }, exec);
    const contractId = created.contract_id;
    const finalized = await callTool(tools, 'proteus_finalize', {
      contract_id: contractId,
      solution: makeSolution(),
    }, exec);
    assert.equal(finalized.ok, false);
    assert.equal(finalized.error.code, 'VERIFICATION_REQUIRED');
    const rootDir = resolveRoot(temp.dir, 'proteus');
    assert.equal(existsSync(solutionPath(rootDir, contractId)), false);
    assert.equal(existsSync(auditPath(rootDir, contractId)), false);
    assert.notEqual(readLedger(rootDir, contractId).state, 'finalized');
  } finally {
    temp.cleanup();
  }
});

test('tools：时间耗尽把 Verified 降级为 LowConfidence（TIME_EXHAUSTED）', async () => {
  const { temp, tools, exec } = setup('full');
  try {
    const created = await callTool(tools, 'proteus_contract', {
      action: 'create',
      contract: makeContract({ time_budget_s: 1 }),
    }, exec);
    const contractId = created.contract_id;
    await callTool(tools, 'proteus_budget', { action: 'start', contract_id: contractId }, exec);
    await callTool(tools, 'proteus_verify', { action: 'run', contract_id: contractId, solution: answerOnlySolution('2') }, exec);
    const run = await callTool(tools, 'proteus_verify', { action: 'plan', contract_id: contractId }, exec);
    assert.equal(run.ok, true);

    // 把起表时间改到 10 分钟前，制造 exhausted
    const rootDir = resolveRoot(temp.dir, 'proteus');
    const ledger = readLedger(rootDir, contractId);
    ledger.budget.started_at = new Date(Date.now() - 600_000).toISOString();
    writeLedger(rootDir, ledger);

    const status = await callTool(tools, 'proteus_budget', { action: 'status', contract_id: contractId }, exec);
    assert.equal(status.state.phase, 'exhausted');
    const solution = makeSolution();
    const evidence = readLedger(rootDir, contractId).evidence;
    const ids = numericIdsOf(evidence);
    solution.steps[1].evidence_refs = [ids[0]];
    solution.steps[2].evidence_refs = [ids[0]];
    const finalized = await callTool(tools, 'proteus_finalize', { contract_id: contractId, solution }, exec);
    assert.equal(finalized.state, 'LowConfidence');
    assert.ok(finalized.reason_codes.includes('TIME_EXHAUSTED'));
  } finally {
    temp.cleanup();
  }
});

test('tools：证明题 Verified 门（FORMAL_EVIDENCE_REQUIRED）', async () => {
  const proofContract = makeContract({
    problem_type: 'proof',
    answer_format: { type: 'proof', tolerance: null, units: null },
    goal: { kind: 'prove', statement: '证明 f 在 R 上单调递增' },
    verification: null,
  });
  // 单元：即使有 numeric+symbolic 两类证据、无 formal/human，也不得 Verified
  const contract = validateContract(proofContract).contract;
  const decision = decideFinalState({
    contract,
    solution: { answer: { value: '由求导可知结论成立' }, steps: makeSolution().steps },
    evidence: [
      makeManualEvidence({ kind: 'numeric', check: 'numeric_residual' }),
      makeManualEvidence({ kind: 'symbolic', check: 'expression_sample' }),
      { ...makeManualEvidence({ kind: 'structural', check: 'answer_format' }), status: 'pass', detail: 'proof' },
    ],
    gradeResult: { traps: [] },
    evidenceMinKinds: 2,
  });
  assert.equal(decision.state, 'LowConfidence');
  assert.deepEqual(decision.reason_codes, ['FORMAL_EVIDENCE_REQUIRED']);

  const { temp, tools, exec } = setup('full');
  try {
    const created = await callTool(tools, 'proteus_contract', { action: 'create', contract: proofContract }, exec);
    const proofSolution = {
      answer: { value: '由求导可知 f 在 R 上单调递增' },
      steps: makeSolution().steps,
    };
    const verified = await callTool(tools, 'proteus_verify', {
      action: 'run',
      contract_id: created.contract_id,
      solution: proofSolution,
    }, exec);
    assert.equal(verified.ok, true);
    assert.equal(verified.evidence.length, 4);
    const finalized = await callTool(tools, 'proteus_finalize', {
      contract_id: created.contract_id,
      solution: proofSolution,
    }, exec);
    assert.equal(finalized.ok, true);
    assert.notEqual(finalized.state, 'Verified');
    assert.ok(finalized.reason_codes.includes('FORMAL_EVIDENCE_REQUIRED'));
  } finally {
    temp.cleanup();
  }
});

test('tools：角色越权返回 ROLE_DENIED', async () => {
  const solver = setup('solver');
  try {
    assert.equal(findTool(solver.tools, 'proteus_contract') !== undefined, true);
    const deniedCreate = await callTool(solver.tools, 'proteus_contract', { action: 'create', contract: makeContract() }, solver.exec);
    assert.equal(deniedCreate.ok, false);
    assert.equal(deniedCreate.error.code, 'ROLE_DENIED');
    const deniedStats = await callTool(solver.tools, 'proteus_route', { action: 'stats' }, solver.exec);
    assert.equal(deniedStats.ok, false);
    assert.equal(deniedStats.error.code, 'ROLE_DENIED');
    const deniedAudit = solver.tools.some((tool) => tool.name === 'proteus_audit');
    assert.equal(deniedAudit, false);
  } finally {
    solver.temp.cleanup();
  }

  const grader = setup('grader');
  try {
    const deniedStart = await callTool(grader.tools, 'proteus_budget', { action: 'start', contract_id: 'sha256:x' }, grader.exec);
    assert.equal(deniedStart.ok, false);
    assert.equal(deniedStart.error.code, 'ROLE_DENIED');
    const deniedCreate = await callTool(grader.tools, 'proteus_contract', { action: 'create', contract: makeContract() }, grader.exec);
    assert.equal(deniedCreate.error.code, 'ROLE_DENIED');
    assert.equal(grader.tools.some((tool) => tool.name === 'proteus_finalize'), false);
  } finally {
    grader.temp.cleanup();
  }
});

test('tools：契约校验失败不落盘；show/verify 缺失账本返回错误码', async () => {
  const { temp, tools, exec } = setup('full');
  try {
    const invalid = await callTool(tools, 'proteus_contract', {
      action: 'create',
      contract: makeContract({ domain: 'astrology' }),
    }, exec);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'CONTRACT_INVALID');
    assert.equal(invalid.state, 'invalid');
    assert.ok(invalid.issues.some((issue) => issue.code === 'DOMAIN'));
    const rootDir = resolveRoot(temp.dir, 'proteus');
    assert.equal(readLedger(rootDir, invalid.contract_id), null);

    const show = await callTool(tools, 'proteus_contract', { action: 'show', contract_id: 'sha256:deadbeef' }, exec);
    assert.equal(show.ok, false);
    assert.equal(show.error.code, 'LEDGER_NOT_FOUND');
    const verify = await callTool(tools, 'proteus_verify', { action: 'plan', contract_id: 'sha256:deadbeef' }, exec);
    assert.equal(verify.ok, false);
    assert.equal(verify.error.code, 'LEDGER_NOT_FOUND');

    const validate = await callTool(tools, 'proteus_contract', { action: 'validate', contract: makeContract() }, exec);
    assert.equal(validate.ok, true);
    assert.equal(validate.persisted, false);
    assert.equal(readLedger(rootDir, validate.contract_id), null);
  } finally {
    temp.cleanup();
  }
});

test('tools：重复 create 幂等，不覆盖已有证据', async () => {
  const { temp, tools, exec } = setup('full');
  try {
    const first = await callTool(tools, 'proteus_contract', { action: 'create', contract: makeContract() }, exec);
    assert.equal(first.existing, false);
    await callTool(tools, 'proteus_verify', { action: 'run', contract_id: first.contract_id, solution: answerOnlySolution('2') }, exec);
    const second = await callTool(tools, 'proteus_contract', { action: 'create', contract: makeContract() }, exec);
    assert.equal(second.ok, true);
    assert.equal(second.existing, true);
    const show = await callTool(tools, 'proteus_contract', { action: 'show', contract_id: first.contract_id }, exec);
    assert.equal(show.evidence_count, 4);
  } finally {
    temp.cleanup();
  }
});

test('tools：提示区块文本包含五态与角色纪律', () => {
  const text = buildPromptSection('solver');
  assert.ok(text.includes('Verified'));
  assert.ok(text.includes('LowConfidence'));
  assert.ok(text.includes('Unknown'));
  assert.ok(text.includes('Ambiguous'));
  assert.ok(text.includes('OutOfSyllabus'));
  assert.ok(text.includes('proteus_verify'));
  assert.ok(text.includes('solver'));
  assert.ok(Object.keys(ROLE_ACTIONS).includes('auditor'));
});

test('tools：finalize 检测 GRADE_DRIFT 并保留审计包可写', async () => {
  const { temp, tools, exec } = setup('full');
  try {
    const created = await callTool(tools, 'proteus_contract', { action: 'create', contract: makeContract() }, exec);
    const contractId = created.contract_id;
    const run = await callTool(tools, 'proteus_verify', { action: 'run', contract_id: contractId, solution: answerOnlySolution('2') }, exec);
    const ids = numericIdsOf(run.evidence);
    const gradedSolution = makeSolution({ symbolic: ids[0], numeric: ids[0] });
    const graded = await callTool(tools, 'proteus_grade', { contract_id: contractId, solution: gradedSolution }, exec);
    assert.equal(graded.predicted_points, 10.5);

    // 换一份得分不同的解答定稿 → 与账本 grade 不一致，必须标 GRADE_DRIFT
    const drifted = makeSolution({ symbolic: ids[0], numeric: null });
    const finalized = await callTool(tools, 'proteus_finalize', { contract_id: contractId, solution: drifted }, exec);
    assert.equal(finalized.ok, true);
    assert.ok(finalized.reason_codes.includes('GRADE_DRIFT'));
    assert.notEqual(finalized.state, 'Verified');

    const rewritten = await callTool(tools, 'proteus_audit', { action: 'write', contract_id: contractId }, exec);
    assert.equal(rewritten.ok, true);
    assert.match(rewritten.bundle_id, /^sha256:/);
    const verified = await callTool(tools, 'proteus_audit', { action: 'verify', contract_id: contractId }, exec);
    assert.equal(verified.ok, true);
    assert.equal(verified.bundle_id, rewritten.bundle_id);
  } finally {
    temp.cleanup();
  }
});
