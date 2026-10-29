import test from 'node:test';
import assert from 'node:assert/strict';
import { grade, RULE_VERSION } from '../lib/rubric.js';
import { validateContract } from '../lib/contract.js';
import { makeContract, makeSolution } from './helpers.js';

function contractWith(rubricOverrides = {}, overrides = {}) {
  const raw = makeContract(overrides);
  return validateContract({
    ...raw,
    grading_rubric: { ...raw.grading_rubric, ...rubricOverrides },
  }).contract;
}

function ev(id, kind, status, claim = 'answer', check = 'numeric_residual') {
  return {
    evidence_id: `ev_${String(id).padStart(12, '0')}`,
    kind,
    check,
    claim,
    status,
    detail: status,
    input_digest: `sha256:${'0'.repeat(64)}`,
    output_digest: `sha256:${'0'.repeat(64)}`,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function fullEvidence(solution) {
  const symbolicId = 'ev_000000000001';
  const numericId = 'ev_000000000002';
  const viaRefs = structuredClone(solution);
  viaRefs.steps[1].evidence_refs = [symbolicId];
  viaRefs.steps[2].evidence_refs = [numericId];
  return {
    solution: viaRefs,
    evidence: [
      ev(1, 'symbolic', 'pass', 'answer', 'expression_sample'),
      ev(2, 'numeric', 'pass', 'answer', 'numeric_residual'),
      ev(3, 'structural', 'pass', 'answer', 'answer_format'),
    ],
  };
}

test('rubric：满分 12 分、答案分与独立证据', () => {
  const contract = validateContract(makeContract()).contract;
  const { solution, evidence } = fullEvidence(makeSolution());
  const result = grade({ contract, solution, evidence });
  assert.equal(result.schema, 'proteus.grade/v1');
  assert.equal(result.rule_version, RULE_VERSION);
  assert.equal(result.max_points, 12);
  assert.equal(result.predicted_points, 12);
  assert.equal(result.answer_points, 2);
  assert.deepEqual(result.step_scores.map((step) => step.earned), [2, 3, 3, 2]);
  assert.deepEqual(result.deductions, []);
  assert.deepEqual(result.traps, []);
  assert.deepEqual(result.independent_kinds, ['numeric', 'symbolic']);
  assert.deepEqual(result.coverage, { steps_verified: 4, steps_total: 4 });
  assert.equal(result.confidence, 0.97);
  assert.match(result.prediction_id, /^gp_[0-9a-f]{12}$/);
  assert.equal(result.contract_id, contract.contract_id);
});

test('rubric：缺证据按 partial 降级（half_on_missing / proportional / all_or_nothing）', () => {
  const contract = contractWith({
    total_points: 10,
    answer_points: 0,
    step_points: [
      { id: 'A', desc: '结构步', points: 2, required: true, evidence: ['structural'], partial: 'all_or_nothing' },
      { id: 'B', desc: '符号步', points: 3, required: true, evidence: ['symbolic'], partial: 'half_on_missing' },
      { id: 'C', desc: '双证据步', points: 5, required: true, evidence: ['symbolic', 'numeric'], partial: 'proportional' },
    ],
  }, { givens: [], domain: 'other' });
  const solution = {
    answer: { value: '1', unit: null },
    steps: [
      { id: 'A', text: '第一步' },
      { id: 'B', text: '第二步' },
      { id: 'C', text: '第三步', evidence_refs: ['ev_000000000001'] },
    ],
  };
  const evidence = [ev(1, 'symbolic', 'pass', 'answer', 'expression_sample')];
  const result = grade({ contract, solution, evidence });
  const scores = Object.fromEntries(result.step_scores.map((step) => [step.id, step.earned]));
  assert.equal(scores.A, 2);
  assert.equal(scores.B, 1.5);
  assert.equal(scores.C, 1.25);
  // 4.75 取 0.5 网格 → 5.0
  assert.equal(result.predicted_points, 5);
  assert.equal(Number.isInteger(result.predicted_points * 2), true);
  // M10：A 全满足、B/C 部分满足 → coverage 只有 1/3
  assert.equal(result.coverage.steps_verified, 1);
  assert.equal(result.confidence, 0.67);

  const allOrNothing = contractWith({
    total_points: 4,
    answer_points: 0,
    step_points: [{ id: 'A', desc: '结构步', points: 4, required: true, evidence: ['symbolic'], partial: 'all_or_nothing' }],
  });
  const zero = grade({
    contract: allOrNothing,
    solution: { answer: { value: '1' }, steps: [{ id: 'A', text: '第一步' }] },
    evidence: [],
  });
  assert.equal(zero.step_scores[0].earned, 0);
  assert.equal(zero.predicted_points, 0);
});

test('rubric：步骤文本缺失必得 0；失败证据清零该步', () => {
  const contract = contractWith({
    total_points: 4,
    answer_points: 0,
    step_points: [
      { id: 'A', desc: 'a', points: 2, required: true, evidence: ['structural'] },
      { id: 'B', desc: 'b', points: 2, required: true, evidence: ['structural'] },
    ],
  });
  const result = grade({
    contract,
    solution: { answer: { value: '1' }, steps: [{ id: 'A', text: '' }, { id: 'B', text: '有字', evidence_refs: ['ev_000000000009'] }] },
    evidence: [ev(9, 'structural', 'fail', 'B', 'answer_format')],
  });
  assert.equal(result.step_scores[0].earned, 0);
  assert.equal(result.step_scores[1].earned, 0);
  assert.equal(result.predicted_points, 0);
});

test('rubric：扣分只算 rule、按 deduction_rules 覆盖、总扣分封顶', () => {
  const contract = contractWith(
    {
      total_points: 10,
      answer_points: 0,
      step_points: [{ id: 'A', desc: 'a', points: 10, required: true, evidence: ['structural'] }],
      deduction_rules: [{ trap: 'T01', deduct: 100 }],
    },
    { domain: 'calculus' },
  );
  const result = grade({
    contract,
    solution: { answer: { value: '1' }, steps: [{ id: 'A', text: '第一步' }] },
    evidence: [],
  });
  assert.equal(result.predicted_points, 0);
  assert.ok(result.deductions.some((deduction) => deduction.trap === 'T01' && deduction.points === 100));
  assert.equal(result.traps.find((trap) => trap.trap === 'T01').basis, 'rule');

  const heuristicOnly = contractWith(
    {
      total_points: 2,
      answer_points: 0,
      step_points: [{ id: 'A', desc: 'a', points: 2, required: true, evidence: ['structural'] }],
    },
    { goal: { kind: 'prove', statement: 'f 在 R 上单调递增' } },
  );
  const heuristic = grade({
    contract: heuristicOnly,
    solution: { answer: { value: '1' }, steps: [{ id: 'A', text: 'f 在 R 上单调递增' }] },
    evidence: [],
  });
  assert.ok(heuristic.traps.some((trap) => trap.trap === 'T11' && trap.basis === 'heuristic'));
  assert.equal(heuristic.deductions.some((deduction) => deduction.trap === 'T11'), false);
});

test('rubric：答案分需要格式合法 + 独立证据', () => {
  const contract = validateContract(makeContract()).contract;
  const solution = makeSolution({ symbolic: 'ev_000000000001', numeric: 'ev_000000000002' });
  const noIndependent = grade({
    contract,
    solution,
    evidence: [ev(1, 'structural', 'pass', 'answer', 'answer_format')],
  });
  assert.equal(noIndependent.answer_points, 0);
  // S1/S4 structural 2+2；S2 缺 symbolic → half 1.5；S3 缺 numeric → 0；答案 0 → 5.5
  assert.equal(noIndependent.predicted_points, 5.5);

  const badFormat = grade({
    contract,
    solution: { answer: { value: '', unit: null }, steps: solution.steps },
    evidence: [ev(1, 'numeric', 'pass', 'answer', 'numeric_residual')],
  });
  assert.equal(badFormat.answer_points, 0);
});

test('rubric：confidence 公式与 prediction_id 确定性', () => {
  const contract = validateContract(makeContract()).contract;
  const { solution, evidence } = fullEvidence(makeSolution());
  const first = grade({ contract, solution, evidence });
  const second = grade({ contract, solution, evidence: structuredClone(evidence) });
  assert.equal(first.prediction_id, second.prediction_id);
  const changed = grade({ contract, solution: { ...solution, answer: { value: '3' } }, evidence });
  assert.notEqual(first.prediction_id, changed.prediction_id);
  // 0.5 + 0.4*1 + 0.1*(2/3) - 0.15*0 = 0.9666… → 0.97
  assert.equal(first.confidence, 0.97);
  assert.equal(Number.isInteger(roundHalfCheck(first.predicted_points)), true);
});

test('rubric：M10 部分证据不得计入 coverage', () => {
  const contract = contractWith({
    total_points: 4,
    answer_points: 0,
    step_points: [
      { id: 'A', desc: '结构+数值', points: 4, required: true, evidence: ['structural', 'numeric'], partial: 'all_or_nothing' },
    ],
  }, { givens: [], domain: 'other' });
  const result = grade({
    contract,
    solution: { answer: { value: '1' }, steps: [{ id: 'A', text: '第一步' }] },
    evidence: [],
  });
  assert.equal(result.step_scores[0].earned, 0);
  assert.deepEqual(result.coverage, { steps_verified: 0, steps_total: 1 });
  assert.deepEqual(result.independent_kinds, []);
});

function roundHalfCheck(value) {
  return Math.round(value * 2) / 2 === value ? Math.round(value * 2) / 2 : value;
}
