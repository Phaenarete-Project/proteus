import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cellStats,
  emptyCell,
  emptyMatrix,
  listCells,
  loadMatrix,
  matrixTotals,
  routeStrategy,
  saveMatrix,
  upsertOutcome,
  weakSiblings,
} from '../lib/matrix.js';
import { validateContract } from '../lib/contract.js';
import { makeContract, makeTempDir } from './helpers.js';

const CONTRACT = validateContract(makeContract()).contract;

test('matrix：空矩阵 / 保存读取 / 原子写', () => {
  const temp = makeTempDir();
  try {
    const empty = emptyMatrix();
    assert.equal(empty.schema, 'proteus.matrix/v1');
    assert.deepEqual(empty.cells, {});
    const path = saveMatrix(temp.dir, empty);
    assert.equal(path, join(temp.dir, 'matrix.json'));
    assert.ok(existsSync(path));
    assert.equal(existsSync(`${path}.tmp`), false);
    const loaded = loadMatrix(temp.dir);
    assert.equal(loaded.schema, 'proteus.matrix/v1');
    assert.deepEqual(loaded.cells, {});
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    assert.match(parsed.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    temp.cleanup();
  }
});

test('matrix：矩阵损坏抛 MATRIX_CORRUPT，不静默覆盖', () => {
  const temp = makeTempDir();
  try {
    mkdirSync(temp.dir, { recursive: true });
    writeFileSync(join(temp.dir, 'matrix.json'), '{bad json');
    assert.throws(() => loadMatrix(temp.dir), (error) => error.code === 'MATRIX_CORRUPT');
    writeFileSync(join(temp.dir, 'matrix.json'), JSON.stringify({ schema: 'other', cells: {} }));
    assert.throws(() => loadMatrix(temp.dir), (error) => error.code === 'MATRIX_CORRUPT');
  } finally {
    temp.cleanup();
  }
});

test('matrix：upsertOutcome 累计计数/分数/时间且不修改入参', () => {
  const matrix = emptyMatrix();
  const predicted = { predicted_points: 9.5, max_points: 12 };
  const once = upsertOutcome(matrix, { contract: CONTRACT, state: 'Verified', predicted, elapsed_s: 100.4, at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(matrix.cells, {});
  assert.equal(Object.keys(once.cells).length, 1);
  const cell = Object.values(once.cells)[0];
  assert.equal(cell.attempts, 1);
  assert.equal(cell.verified, 1);
  assert.equal(cell.points_earned, 9.5);
  assert.equal(cell.points_possible, 12);
  assert.deepEqual(cell.time_samples_s, [100]);
  assert.equal(cell.last_attempt_at, '2026-01-01T00:00:00.000Z');
  assert.equal(cell.knowledge_point, 'GK.FUNC.DERIV');

  const twice = upsertOutcome(once, { contract: CONTRACT, state: 'LowConfidence', predicted, elapsed_s: 200, at: '2026-01-02T00:00:00.000Z' });
  const cell2 = Object.values(twice.cells)[0];
  assert.equal(cell2.attempts, 2);
  assert.equal(cell2.verified, 1);
  assert.equal(cell2.low_confidence, 1);
  assert.equal(cell2.points_earned, 19);
  assert.equal(cell2.points_possible, 24);
  assert.deepEqual(cell2.time_samples_s, [100, 200]);
});

test('matrix：cellStats 派生指标与优先级公式', () => {
  const cell = {
    attempts: 5,
    verified: 2,
    low_confidence: 1,
    unknown: 1,
    ambiguous: 0,
    out_of_syllabus: 0,
    points_earned: 24,
    points_possible: 60,
    time_samples_s: [100, 200, 300],
  };
  const stats = cellStats(cell, 5);
  assert.equal(stats.coverage, 1);
  assert.equal(stats.correctness, 0.4);
  assert.equal(stats.step_score, 0.4);
  assert.equal(stats.unknown_rate, 0.4);
  assert.equal(stats.time_p50, 200);
  const expectedPriority = 0.3 * 0 + 0.3 * 0.6 + 0.2 * 0.6 + 0.1 * 0.4 + 0.1 * (200 / 900);
  assert.equal(stats.priority, Math.round(expectedPriority * 1e6) / 1e6);
  assert.equal(cellStats(emptyCell(CONTRACT)).priority, 0.8);
});

test('matrix：listCells 按 priority 降序、weakest 截断', () => {
  const first = upsertOutcome(emptyMatrix(), {
    contract: CONTRACT,
    state: 'Verified',
    predicted: { predicted_points: 12, max_points: 12 },
    elapsed_s: 60,
    at: '2026-01-01T00:00:00.000Z',
  });
  const second = upsertOutcome(first, {
    contract: validateContract(makeContract({ domain: 'probability', knowledge_points: ['GK.PROB.EVENT'], problem: { text: '求概率' }, givens: [] })).contract,
    state: 'Unknown',
    predicted: { predicted_points: 0, max_points: 12 },
    at: '2026-01-02T00:00:00.000Z',
  });
  const listed = listCells(second, { targetAttempts: 5, limit: 1 });
  assert.equal(listed.cells.length, 2);
  assert.equal(listed.cells[0].priority >= listed.cells[1].priority, true);
  assert.equal(listed.weakest.length, 1);
  assert.equal(listed.weakest[0].cell_key, listed.cells[0].cell_key);
  assert.deepEqual(matrixTotals(second), {
    cells: 2,
    attempts: 2,
    verified: 1,
    low_confidence: 0,
    unknown: 1,
    ambiguous: 0,
    out_of_syllabus: 0,
    points_earned: 12,
    points_possible: 24,
    overall_step_score: 0.5,
  });
});

test('matrix：routeStrategy 确定性映射', () => {
  assert.equal(routeStrategy(validateContract(makeContract()).contract).id, 'symbolic_first');
  assert.equal(routeStrategy(validateContract(makeContract({ domain: 'probability' })).contract).id, 'numeric_first');
  assert.equal(routeStrategy(validateContract(makeContract({ problem_type: 'proof', answer_format: { type: 'proof' }, goal: { kind: 'prove', statement: '证明' } })).contract).id, 'formal_first');
  assert.equal(routeStrategy(validateContract(makeContract({ problem_type: 'classification' })).contract).id, 'case_enumeration');
  assert.equal(routeStrategy(validateContract(makeContract({ problem_type: 'construction' })).contract).id, 'construction_search');
  assert.equal(routeStrategy(validateContract(makeContract({ problem: { text: '含绝对值' } })).contract).id, 'case_enumeration');
  const strategy = routeStrategy(CONTRACT);
  assert.ok(Array.isArray(strategy.checklist));
  assert.ok(Array.isArray(strategy.preferred_checks));
});

test('matrix：weakSiblings 返回同域更高优先级格子', () => {
  let matrix = upsertOutcome(emptyMatrix(), {
    contract: CONTRACT,
    state: 'Unknown',
    predicted: { predicted_points: 0, max_points: 12 },
    at: '2026-01-01T00:00:00.000Z',
  });
  const siblingContract = validateContract(makeContract({
    knowledge_points: ['GK.FUNC.MONO'],
    problem: { text: '求单调性' },
  })).contract;
  matrix = upsertOutcome(matrix, {
    contract: siblingContract,
    state: 'Verified',
    predicted: { predicted_points: 12, max_points: 12 },
    at: '2026-01-02T00:00:00.000Z',
  });
  const siblings = weakSiblings(matrix, CONTRACT);
  assert.equal(siblings.length, 1);
  assert.equal(siblings[0].cell_key, 'gaokao-math|calculus|GK.FUNC.MONO|computation|medium');
});
