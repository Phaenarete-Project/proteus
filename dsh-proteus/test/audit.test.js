import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildBundle,
  defaultEnvironment,
  readBundle,
  REASON_CODES,
  verifyBundle,
  writeBundle,
} from '../lib/audit.js';
import { validateContract } from '../lib/contract.js';
import { runChecks } from '../lib/evidence.js';
import { grade } from '../lib/rubric.js';
import { appendTimeline, createLedger } from '../lib/store.js';
import { makeContract, makeSolution, makeTempDir } from './helpers.js';

function buildLedgerFixture() {
  const contract = validateContract(makeContract()).contract;
  const solution = makeSolution();
  const evidence = runChecks({ contract, solution });
  const numericIds = evidence.filter((item) => item.kind === 'numeric').map((item) => item.evidence_id);
  solution.steps[1].evidence_refs = numericIds.slice(0, 1);
  solution.steps[2].evidence_refs = numericIds.slice(0, 1);
  const gradeResult = grade({ contract, solution, evidence });
  const ledger = createLedger(contract);
  appendTimeline(ledger, 'contract.created', '2026-01-01T00:00:00.000Z');
  appendTimeline(ledger, 'evidence.appended', '2026-01-01T00:01:00.000Z');
  appendTimeline(ledger, 'finalize.decided', '2026-01-01T00:02:00.000Z');
  ledger.evidence = evidence;
  ledger.grade = gradeResult;
  ledger.final = {
    state: 'LowConfidence',
    reason_codes: ['EVIDENCE_INSUFFICIENT'],
    decided_at: '2026-01-01T00:02:00.000Z',
    solution,
    grade: gradeResult,
    predicted_points: gradeResult.predicted_points,
    max_points: gradeResult.max_points,
    evidence_summary: { pass: 4, fail: 0, unknown: 0, total: 4, independent_kinds: ['numeric'] },
  };
  return { ledger, contract, solution, gradeResult, evidence };
}

test('audit：bundle_id 稳定且 verifyBundle 通过', () => {
  const { ledger } = buildLedgerFixture();
  const environment = defaultEnvironment(ledger.contract, { model: 'test-model' });
  const first = buildBundle({ ledger, environment, at: '2026-01-01T00:02:00.000Z' });
  const second = buildBundle({ ledger: structuredClone(ledger), environment, at: '2026-01-01T00:02:00.000Z' });
  assert.equal(first.schema, 'proteus.audit/v1');
  assert.equal(first.bundle_id, second.bundle_id);
  assert.match(first.bundle_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.state.state, 'LowConfidence');
  assert.equal(first.environment.rule_version, 'proteus-rubric/v1');
  const result = verifyBundle(first);
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
});

test('audit：篡改证据 / 契约 / 时间线 / bundle_id 都会被检测', () => {
  const { ledger } = buildLedgerFixture();
  const bundle = buildBundle({ ledger, environment: defaultEnvironment(ledger.contract), at: '2026-01-01T00:02:00.000Z' });

  const tamperedEvidence = structuredClone(bundle);
  tamperedEvidence.evidence[0].status = tamperedEvidence.evidence[0].status === 'pass' ? 'fail' : 'pass';
  const evidenceResult = verifyBundle(tamperedEvidence);
  assert.equal(evidenceResult.ok, false);
  assert.ok(evidenceResult.issues.some((issue) => issue.code === 'EVIDENCE_DIGEST'));
  assert.ok(evidenceResult.issues.some((issue) => issue.code === 'BUNDLE_ID'));

  const tamperedContract = structuredClone(bundle);
  tamperedContract.contract.problem.text = '被改过的题目';
  const contractResult = verifyBundle(tamperedContract);
  assert.equal(contractResult.ok, false);
  assert.ok(contractResult.issues.some((issue) => issue.code === 'CONTRACT_ID'));

  const tamperedTimeline = structuredClone(bundle);
  tamperedTimeline.timeline[0].event = 'forged.event';
  const timelineResult = verifyBundle(tamperedTimeline);
  assert.ok(timelineResult.issues.some((issue) => issue.code === 'TIMELINE_HASH'));

  const tamperedId = structuredClone(bundle);
  tamperedId.bundle_id = 'sha256:deadbeef';
  const idResult = verifyBundle(tamperedId);
  assert.ok(idResult.issues.some((issue) => issue.code === 'BUNDLE_ID'));
});

test('audit：证据 id / 评分一致性校验', () => {
  const { ledger } = buildLedgerFixture();
  const bundle = buildBundle({ ledger, environment: defaultEnvironment(ledger.contract) });

  const badId = structuredClone(bundle);
  badId.evidence[0].evidence_id = 'ev_000000000000';
  assert.ok(verifyBundle(badId).issues.some((issue) => issue.code === 'EVIDENCE_ID'));

  const badGrade = structuredClone(bundle);
  badGrade.grade.predicted_points = 999;
  assert.ok(verifyBundle(badGrade).issues.some((issue) => issue.code === 'GRADE_RANGE'));

  const badClaim = structuredClone(bundle);
  badClaim.evidence[0].claim = 'S9';
  assert.ok(verifyBundle(badClaim).issues.some((issue) => issue.code === 'EVIDENCE_CLAIM'));

  const badReason = structuredClone(bundle);
  badReason.state.reason_codes = ['NOT_A_REASON'];
  assert.ok(verifyBundle(badReason).issues.some((issue) => issue.code === 'STATE_REASONS'));
});

test('audit：写读审计包、缺失与损坏', () => {
  const temp = makeTempDir();
  try {
    const { ledger, contract } = buildLedgerFixture();
    const bundle = buildBundle({ ledger, environment: defaultEnvironment(contract) });
    const path = writeBundle(temp.dir, bundle);
    assert.equal(path, join(temp.dir, 'audit', `${contract.contract_id.replace('sha256:', '')}.json`));
    assert.ok(existsSync(path));
    const loaded = readBundle(path);
    assert.equal(loaded.bundle_id, bundle.bundle_id);
    assert.equal(readBundle(join(temp.dir, 'missing.json')), null);

    writeFileSync(path, '{bad');
    assert.throws(() => readBundle(path), (error) => error.code === 'BUNDLE_CORRUPT');

    mkdirSync(join(temp.dir, 'audit'), { recursive: true });
    writeFileSync(join(temp.dir, 'audit', 'bad.json'), JSON.stringify({ schema: 'x' }));
    assert.throws(() => readBundle(join(temp.dir, 'audit', 'bad.json')), (error) => error.code === 'BUNDLE_CORRUPT');
  } finally {
    temp.cleanup();
  }
});

test('audit：空 final 的 bundle 是 Unknown；reason codes 含证明题门', () => {
  const contract = validateContract(makeContract()).contract;
  const ledger = createLedger(contract);
  appendTimeline(ledger, 'contract.created', '2026-01-01T00:00:00.000Z');
  const bundle = buildBundle({ ledger, environment: defaultEnvironment(contract) });
  assert.equal(bundle.solution, null);
  assert.equal(bundle.state.state, 'Unknown');
  assert.ok(REASON_CODES.includes('FORMAL_EVIDENCE_REQUIRED'));
  assert.ok(REASON_CODES.includes('GRADE_DRIFT'));
});
