import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_SCHEMA,
  contractDigest,
  contractSummary,
  matrixCellKey,
  normalizeContract,
  validateContract,
} from '../lib/contract.js';
import { digest } from '../lib/canonical.js';
import { makeContract } from './helpers.js';

test('contract：合法契约 ready 且派生字段正确', () => {
  const result = validateContract(makeContract());
  assert.equal(result.ok, true);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.issues, []);
  assert.match(result.contract.contract_id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.contract.matrix_cell, 'gaokao-math|calculus|GK.FUNC.DERIV|computation|medium');
  assert.equal(matrixCellKey(result.contract), result.contract.matrix_cell);
});

test('contract：contract_id 与键顺序无关、与派生字段无关', () => {
  const raw = makeContract();
  const shuffled = Object.fromEntries(Object.entries(raw).reverse());
  const a = validateContract(raw).contract;
  const b = validateContract(shuffled).contract;
  assert.equal(a.contract_id, b.contract_id);
  const contaminated = { ...raw, contract_id: 'sha256:deadbeef', matrix_cell: 'x|y|z|w|v' };
  assert.equal(validateContract(contaminated).contract.contract_id, a.contract_id);
  const expected = digest((() => {
    const { contract_id: _id, matrix_cell: _cell, ...rest } = normalizeContract(raw);
    return rest;
  })());
  assert.equal(contractDigest(a), expected);
});

test('contract：缺点数报 POINTS_SUM 且 state=invalid', () => {
  const rubric = makeContract().grading_rubric;
  const raw = makeContract({
    grading_rubric: {
      ...rubric,
      total_points: 15,
    },
  });
  const result = validateContract(raw);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'POINTS_SUM' && issue.level === 'error'));
});

test('contract：枚举错误 / 空题面 / 空知识点 / step 重复', () => {
  const result = validateContract(makeContract({
    domain: 'astrology',
    problem: { text: '   ' },
    knowledge_points: [],
    grading_rubric: {
      ...makeContract().grading_rubric,
      step_points: [
        { id: 'S1', desc: 'a', points: 6, required: true, evidence: ['structural'] },
        { id: 'S1', desc: 'b', points: 4, required: true, evidence: ['structural'] },
      ],
    },
  }));
  assert.equal(result.state, 'invalid');
  const codes = result.issues.map((issue) => issue.code);
  for (const code of ['DOMAIN', 'PROBLEM_TEXT', 'KP_EMPTY', 'STEP_DUP']) {
    assert.ok(codes.includes(code), `应包含 ${code}，实际 ${codes.join(',')}`);
  }
});

test('contract：歧义 → ambiguous；大纲外 → out_of_syllabus', () => {
  const ambiguous = validateContract(makeContract({ ambiguity: { severity: 'blocking', flags: [{ code: 'X', detail: '未说明方向' }] } }));
  assert.equal(ambiguous.ok, true);
  assert.equal(ambiguous.state, 'ambiguous');
  assert.ok(ambiguous.issues.some((issue) => issue.code === 'AMBIGUITY' && issue.level === 'warning'));

  const outOfSyllabus = validateContract(makeContract({ syllabus: { in_syllabus: false, out_of_syllabus: ['留数定理'] } }));
  assert.equal(outOfSyllabus.state, 'out_of_syllabus');
  assert.ok(outOfSyllabus.issues.some((issue) => issue.code === 'OUT_OF_SYLLABUS'));
});

test('contract：数值答案必须有 tolerance；证明题格式提示', () => {
  const numeric = validateContract(makeContract({
    answer_format: { type: 'numerical', tolerance: null, units: null },
    problem_type: 'proof',
  }));
  const codes = numeric.issues.map((issue) => issue.code);
  assert.ok(codes.includes('TOLERANCE'));
  assert.ok(codes.includes('PROOF_FORMAT'));
  assert.equal(numeric.state, 'invalid');
});

test('contract：单位、知识点格式提示、预算非法', () => {
  const result = validateContract(makeContract({
    knowledge_points: ['bad id'],
    time_budget_s: 0,
    answer_format: { type: 'exact', tolerance: null, units: 'cm^2' },
    syllabus: { in_syllabus: true, out_of_syllabus: ['洛必达'] },
    ambiguity: { severity: 'none', flags: [] },
  }));
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes('KP_FORMAT'));
  assert.ok(codes.includes('BUDGET'));
  assert.equal(result.state, 'invalid');
  const warningOnly = validateContract(makeContract({ knowledge_points: ['bad id'] }));
  assert.equal(warningOnly.ok, true);
  assert.equal(warningOnly.state, 'ready');
  assert.ok(warningOnly.issues.some((issue) => issue.code === 'KP_FORMAT' && issue.level === 'warning'));
});

test('contract：normalize 保留未知字段，派生字段重算', () => {
  const contract = normalizeContract(makeContract({ distractors: ['1', '3'], schema: 'bogus' }));
  assert.deepEqual(contract.distractors, ['1', '3']);
  assert.equal(contract.schema, CONTRACT_SCHEMA);
  assert.equal(contract.contract_id, contractDigest(contract));
  assert.ok(contractSummary(contract).contract_id);
  assert.equal(contractSummary(contract).total_points, 12);
});
