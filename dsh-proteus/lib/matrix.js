/**
 * 考试矩阵：把「通杀」拆成格子上的可统计指标。
 *
 * 格子键为 `exam|domain|knowledge_point|problem_type|difficulty`，与契约的
 * matrix_cell 一致。所有指标都是确定性纯函数，便于测试与审计。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matrixCellKey } from './contract.js';
import { writeJsonAtomic, codedError } from './store.js';

export const MATRIX_SCHEMA = 'proteus.matrix/v1';
export const DEFAULT_TARGET_ATTEMPTS = 5;

const STATE_FIELDS = {
  Verified: 'verified',
  LowConfidence: 'low_confidence',
  Unknown: 'unknown',
  Ambiguous: 'ambiguous',
  OutOfSyllabus: 'out_of_syllabus',
};

export function emptyMatrix() {
  return { schema: MATRIX_SCHEMA, updated_at: new Date().toISOString(), cells: {} };
}

/**
 * 读矩阵。缺失返回空矩阵；损坏抛 MATRIX_CORRUPT（不静默覆盖）。
 * @param {string} rootDir 已解析的工作区根目录
 */
export function loadMatrix(rootDir) {
  const path = join(rootDir, 'matrix.json');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyMatrix();
    throw codedError('MATRIX_CORRUPT', `读取矩阵失败 ${path}: ${error?.message ?? error}`);
  }
  let matrix;
  try {
    matrix = JSON.parse(text);
  } catch (error) {
    throw codedError('MATRIX_CORRUPT', `矩阵 JSON 损坏 ${path}: ${error?.message ?? error}`);
  }
  if (!matrix || typeof matrix !== 'object' || matrix.schema !== MATRIX_SCHEMA) {
    throw codedError('MATRIX_CORRUPT', `矩阵 schema 不符 ${path}`);
  }
  if (!matrix.cells || typeof matrix.cells !== 'object') matrix.cells = {};
  return matrix;
}

/** 原子写矩阵；updated_at 由服务端重写。 */
export function saveMatrix(rootDir, matrix) {
  const value = {
    schema: MATRIX_SCHEMA,
    updated_at: new Date().toISOString(),
    cells: matrix?.cells && typeof matrix.cells === 'object' ? matrix.cells : {},
  };
  writeJsonAtomic(join(rootDir, 'matrix.json'), value);
  return join(rootDir, 'matrix.json');
}

function number(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function initializeCell(contract) {
  return {
    exam: contract.exam ?? 'custom',
    domain: contract.domain ?? 'other',
    knowledge_point: Array.isArray(contract.knowledge_points) && contract.knowledge_points.length > 0
      ? String(contract.knowledge_points[0])
      : 'UNKNOWN',
    problem_type: contract.problem_type ?? 'computation',
    difficulty: contract.difficulty ?? 'medium',
    attempts: 0,
    verified: 0,
    low_confidence: 0,
    unknown: 0,
    ambiguous: 0,
    out_of_syllabus: 0,
    points_earned: 0,
    points_possible: 0,
    time_samples_s: [],
    last_attempt_at: null,
  };
}

/** 零值格子（新题尚未作答时的占位）。 */
export function emptyCell(contract) {
  return initializeCell(contract ?? {});
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 追加一次作答结果，返回新矩阵（不修改入参）。
 * @param {object} matrix
 * @param {{contract: object, state: string, predicted: object, elapsed_s?: number, at?: string|Date}} outcome
 */
export function upsertOutcome(matrix, { contract, state, predicted, elapsed_s, at } = {}) {
  const next = clone(matrix ?? emptyMatrix());
  if (!next.cells || typeof next.cells !== 'object') next.cells = {};
  const cellKey = matrixCellKey(contract);
  const cell = next.cells[cellKey] ?? initializeCell(contract);

  cell.attempts = number(cell.attempts) + 1;
  const stateField = STATE_FIELDS[state];
  if (stateField) cell[stateField] = number(cell[stateField]) + 1;

  const max = Number.isFinite(predicted?.max_points) ? predicted.max_points : number(contract?.grading_rubric?.total_points);
  const earned = Number.isFinite(predicted?.predicted_points) ? predicted.predicted_points : 0;
  cell.points_earned = number(cell.points_earned) + earned;
  cell.points_possible = number(cell.points_possible) + max;

  if (Number.isFinite(elapsed_s) && elapsed_s >= 0) {
    const samples = Array.isArray(cell.time_samples_s) ? cell.time_samples_s.slice() : [];
    samples.push(Math.round(elapsed_s));
    cell.time_samples_s = samples.slice(-30);
  }
  cell.last_attempt_at = typeof at === 'string' ? at : new Date(at ?? Date.now()).toISOString();
  next.cells[cellKey] = cell;
  next.updated_at = new Date(at ?? Date.now()).toISOString();
  return next;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function round6(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 派生指标。
 * @param {object} cell
 * @param {number} [targetAttempts]
 */
export function cellStats(cell, targetAttempts = DEFAULT_TARGET_ATTEMPTS) {
  const source = cell && typeof cell === 'object' ? cell : {};
  const attempts = number(source.attempts);
  const verified = number(source.verified);
  const target = Number.isFinite(targetAttempts) && targetAttempts > 0 ? targetAttempts : DEFAULT_TARGET_ATTEMPTS;
  const coverage = Math.min(1, attempts / target);
  const correctness = attempts > 0 ? verified / attempts : 0;
  const pointsPossible = number(source.points_possible);
  const stepScore = pointsPossible > 0 ? number(source.points_earned) / pointsPossible : 0;
  const unknownRate = attempts > 0
    ? (number(source.unknown) + number(source.low_confidence)) / attempts
    : 0;
  const timeP50 = median(source.time_samples_s);
  const priority = 0.3 * (1 - coverage)
    + 0.3 * (1 - correctness)
    + 0.2 * (1 - Math.min(1, stepScore))
    + 0.1 * unknownRate
    + 0.1 * Math.min(1, timeP50 / 900);
  return {
    attempts,
    coverage: round6(coverage),
    correctness: round6(correctness),
    step_score: round6(stepScore),
    unknown_rate: round6(unknownRate),
    time_p50: round6(timeP50),
    priority: round6(priority),
  };
}

function cellEntries(matrix, targetAttempts) {
  const cells = matrix?.cells && typeof matrix.cells === 'object' ? matrix.cells : {};
  return Object.entries(cells).map(([cellKey, cell]) => {
    const metrics = cellStats(cell, targetAttempts);
    return {
      cell_key: cellKey,
      exam: cell.exam ?? null,
      domain: cell.domain ?? null,
      knowledge_point: cell.knowledge_point ?? null,
      problem_type: cell.problem_type ?? null,
      difficulty: cell.difficulty ?? null,
      attempts: metrics.attempts,
      verified: number(cell.verified),
      low_confidence: number(cell.low_confidence),
      unknown: number(cell.unknown),
      ambiguous: number(cell.ambiguous),
      out_of_syllabus: number(cell.out_of_syllabus),
      points_earned: number(cell.points_earned),
      points_possible: number(cell.points_possible),
      last_attempt_at: cell.last_attempt_at ?? null,
      metrics,
      priority: metrics.priority,
    };
  }).sort((a, b) => (b.priority - a.priority) || (a.cell_key < b.cell_key ? -1 : a.cell_key > b.cell_key ? 1 : 0));
}

/**
 * 列出格子（priority 降序）与最弱格子。
 * @param {object} matrix
 * @param {{targetAttempts?: number, limit?: number}} [options]
 */
export function listCells(matrix, { targetAttempts = DEFAULT_TARGET_ATTEMPTS, limit = 10 } = {}) {
  const cells = cellEntries(matrix, targetAttempts);
  const size = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  return { cells, weakest: cells.slice(0, size) };
}

const STRATEGIES = {
  symbolic_first: {
    id: 'symbolic_first',
    name: '符号优先',
    checklist: ['先确定定义域', '化简/求导/积分走符号路径', '检查恒等变形', '最后数值回代'],
    preferred_checks: ['expression_sample', 'domain_probe', 'answer_format'],
  },
  numeric_first: {
    id: 'numeric_first',
    name: '数值优先',
    checklist: ['构造小规模数值例子', '用具体值验证命题', '扫描多解与边界', '再回到一般论证'],
    preferred_checks: ['numeric_residual', 'answer_format', 'domain_probe'],
  },
  formal_first: {
    id: 'formal_first',
    name: '形式化优先',
    checklist: ['明确已知与结论', '选择定理并写全条件', '双向证明不混用', '检查反例'],
    preferred_checks: ['answer_format', 'numeric_residual'],
  },
  case_enumeration: {
    id: 'case_enumeration',
    name: '分类讨论',
    checklist: ['列出全部情形', '逐情形给出结论', '去重与并集', '检查边界情形'],
    preferred_checks: ['numeric_residual', 'answer_format'],
  },
  construction_search: {
    id: 'construction_search',
    name: '构造搜索',
    checklist: ['构造候选对象', '验证全部性质', '排除退化情形', '给出唯一性说明'],
    preferred_checks: ['numeric_residual', 'answer_format'],
  },
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);

/**
 * 根据契约确定策略（确定性映射）。
 * @param {object} contract
 * @returns {object} Strategy（深拷贝，调用方可安全修改）
 */
export function routeStrategy(contract) {
  const type = contract?.problem_type;
  const text = typeof contract?.problem?.text === 'string' ? contract.problem.text : '';
  let id = 'symbolic_first';
  if (type === 'proof') id = 'formal_first';
  else if (type === 'construction') id = 'construction_search';
  else if (type === 'classification') id = 'case_enumeration';
  else if (/绝对值|参数|分类/.test(text)) id = 'case_enumeration';
  else if (contract?.domain === 'calculus' || contract?.domain === 'series' || contract?.domain === 'inequality') id = 'symbolic_first';
  else if (contract?.domain === 'probability' || contract?.domain === 'geometry') id = 'numeric_first';
  return clone(STRATEGIES[id]);
}

/**
 * 同域兄弟格子的弱项（按 priority 降序，给主控参考该域最该补的格子）。
 * @returns {object[]}
 */
export function weakSiblings(matrix, contract, limit = 3) {
  const currentKey = matrixCellKey(contract);
  const targetAttempts = DEFAULT_TARGET_ATTEMPTS;
  const entries = cellEntries(matrix, targetAttempts);
  return entries
    .filter((entry) => entry.cell_key !== currentKey
      && entry.exam === (contract?.exam ?? 'custom')
      && entry.domain === (contract?.domain ?? 'other'))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit)
    .map((entry) => ({
      cell_key: entry.cell_key,
      priority: entry.priority,
      coverage: entry.metrics.coverage,
      correctness: entry.metrics.correctness,
      attempts: entry.attempts,
    }));
}

/** 矩阵统计（工具 stats 用）。 */
export function matrixTotals(matrix) {
  const cells = matrix?.cells && typeof matrix.cells === 'object' ? Object.values(matrix.cells) : [];
  const totals = {
    cells: cells.length,
    attempts: 0,
    verified: 0,
    low_confidence: 0,
    unknown: 0,
    ambiguous: 0,
    out_of_syllabus: 0,
    points_earned: 0,
    points_possible: 0,
    overall_step_score: 0,
  };
  for (const cell of cells) {
    totals.attempts += number(cell.attempts);
    totals.verified += number(cell.verified);
    totals.low_confidence += number(cell.low_confidence);
    totals.unknown += number(cell.unknown);
    totals.ambiguous += number(cell.ambiguous);
    totals.out_of_syllabus += number(cell.out_of_syllabus);
    totals.points_earned += number(cell.points_earned);
    totals.points_possible += number(cell.points_possible);
  }
  totals.points_earned = round6(totals.points_earned);
  totals.points_possible = round6(totals.points_possible);
  totals.overall_step_score = totals.points_possible > 0 ? round6(totals.points_earned / totals.points_possible) : 0;
  return totals;
}

/** 读取矩阵，失败时退回空矩阵（仅用于不关键的展示路径）。 */
export function loadMatrixSafe(rootDir) {
  try {
    return { matrix: loadMatrix(rootDir), error: null };
  } catch (error) {
    return { matrix: emptyMatrix(), error };
  }
}

