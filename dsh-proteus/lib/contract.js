/**
 * ExamContract：规范化、校验、派生字段（contract_id / matrix_cell）。
 *
 * 契约是 Proteus 的约束根：没有合法契约不进入求解。校验返回问题列表而不是抛错，
 * 让工具把 issues 原样交给模型。所有派生哈希只依赖 canonicalJson 结果。
 */

import { digest } from './canonical.js';

export const CONTRACT_SCHEMA = 'proteus.contract/v1';
export const CONTRACT_ID_PREFIX = 'sha256:';

export const EXAMS = ['gaokao-math', 'kaoyan-math1', 'custom'];
export const DOMAINS = ['calculus', 'linear_algebra', 'probability', 'geometry', 'series', 'inequality', 'complex', 'other'];
export const PROBLEM_TYPES = ['multiple_choice', 'fill_blank', 'computation', 'proof', 'construction', 'classification'];
export const GOAL_KINDS = ['evaluate', 'prove', 'construct', 'classify', 'find_range'];
export const ANSWER_TYPES = ['exact', 'numerical', 'interval', 'expression', 'set', 'proof'];
export const EVIDENCE_KINDS = ['structural', 'numeric', 'symbolic', 'formal', 'human'];
export const RUBRIC_SOURCES = ['official', 'inferred', 'model'];
export const DIFFICULTIES = ['easy', 'medium', 'hard'];
export const AMBIGUITY_SEVERITIES = ['none', 'minor', 'blocking'];
export const PARTIAL_MODES = ['all_or_nothing', 'half_on_missing', 'proportional'];

export const KNOWLEDGE_POINT_PATTERN = /^[A-Z0-9]+(\.[A-Z0-9_]+)+$/;

const KNOWN_TOP_LEVEL = new Set([
  'schema', 'contract_id', 'exam', 'problem', 'domain', 'knowledge_points', 'problem_type',
  'givens', 'goal', 'answer_format', 'grading_rubric', 'verification', 'time_budget_s',
  'difficulty', 'ambiguity', 'syllabus', 'matrix_cell',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeTolerance(raw) {
  if (!isPlainObject(raw)) return null;
  const tolerance = {};
  if (Number.isFinite(raw.abs)) tolerance.abs = raw.abs;
  if (Number.isFinite(raw.rel)) tolerance.rel = raw.rel;
  return Object.keys(tolerance).length > 0 ? tolerance : null;
}

/** 把契约规范化为纯 JSON；未知顶层字段原样保留，派生字段重算。 */
export function normalizeContract(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const problem = isPlainObject(source.problem) ? source.problem : {};
  const goal = isPlainObject(source.goal) ? source.goal : {};
  const answerFormat = isPlainObject(source.answer_format) ? source.answer_format : {};
  const rubric = isPlainObject(source.grading_rubric) ? source.grading_rubric : {};
  const verification = isPlainObject(source.verification) ? source.verification : null;
  const ambiguity = isPlainObject(source.ambiguity) ? source.ambiguity : {};
  const syllabus = isPlainObject(source.syllabus) ? source.syllabus : {};

  const contract = {
    schema: CONTRACT_SCHEMA,
    contract_id: '',
    exam: asString(source.exam, 'custom'),
    problem: {
      ...problem,
      source: problem.source === undefined ? null : problem.source,
      text: asString(problem.text),
      attachments: asArray(problem.attachments),
    },
    domain: asString(source.domain, 'other'),
    knowledge_points: asArray(source.knowledge_points).map((item) => String(item)),
    problem_type: asString(source.problem_type, 'computation'),
    givens: asArray(source.givens).filter(isPlainObject).map((given) => ({
      ...given,
      id: asString(given.id),
      text: asString(given.text),
      symbol: given.symbol === undefined ? null : given.symbol,
      required: given.required === true,
    })),
    goal: {
      ...goal,
      kind: asString(goal.kind, 'evaluate'),
      statement: asString(goal.statement),
    },
    answer_format: {
      ...answerFormat,
      type: asString(answerFormat.type, 'exact'),
      tolerance: normalizeTolerance(answerFormat.tolerance),
      units: typeof answerFormat.units === 'string' && answerFormat.units.trim() !== '' ? answerFormat.units : null,
      endpoints: isPlainObject(answerFormat.endpoints) ? answerFormat.endpoints : null,
    },
    grading_rubric: {
      source: asString(rubric.source, 'inferred'),
      total_points: asNumber(rubric.total_points, 0),
      answer_points: asNumber(rubric.answer_points, 0),
      step_points: asArray(rubric.step_points).filter(isPlainObject).map((step) => ({
        ...step,
        id: asString(step.id),
        desc: asString(step.desc),
        points: asNumber(step.points, 0),
        required: step.required !== false,
        evidence: asArray(step.evidence),
        partial: asString(step.partial, 'all_or_nothing'),
      })),
      deduction_rules: asArray(rubric.deduction_rules).filter(isPlainObject).map((rule) => ({
        ...rule,
        trap: asString(rule.trap),
        deduct: asNumber(rule.deduct, 0),
      })),
    },
    verification: verification === null ? null : normalizeVerification(verification),
    time_budget_s: asNumber(source.time_budget_s, 900),
    difficulty: asString(source.difficulty, 'medium'),
    ambiguity: {
      ...ambiguity,
      severity: asString(ambiguity.severity, 'none'),
      flags: asArray(ambiguity.flags).filter(isPlainObject),
    },
    syllabus: {
      ...syllabus,
      in_syllabus: syllabus.in_syllabus !== false,
      out_of_syllabus: asArray(syllabus.out_of_syllabus).map((item) => String(item)),
    },
    matrix_cell: '',
  };

  // 保留未知顶层字段（如 distractors、expected_solution_count 的扩展位置），
  // 但派生字段永远由工具重算。
  for (const [key, value] of Object.entries(source)) {
    if (!KNOWN_TOP_LEVEL.has(key) && value !== undefined) contract[key] = value;
  }
  contract.contract_id = contractDigest(contract);
  contract.matrix_cell = matrixCellKey(contract);
  return contract;
}

function normalizeVerification(verification) {
  const sampleRange = asArray(verification.sample_range);
  const range = sampleRange.length === 2 && sampleRange.every((n) => Number.isFinite(n))
    ? [sampleRange[0], sampleRange[1]]
    : [-10, 10];
  return {
    ...verification,
    equations: asArray(verification.equations).map((item) => String(item)),
    reference_expr: typeof verification.reference_expr === 'string' ? verification.reference_expr : null,
    variables: asArray(verification.variables).map((item) => String(item)),
    sample_range: range,
    seed: asNumber(verification.seed, 42),
    checks: asArray(verification.checks).map((item) => String(item)),
  };
}

/**
 * 契约摘要：去掉 contract_id 与 matrix_cell 两个派生字段后的 canonicalJson 哈希。
 * @param {object} contract
 * @returns {string} `sha256:<hex>`
 */
export function contractDigest(contract) {
  if (!isPlainObject(contract)) throw new TypeError('contractDigest 需要契约对象');
  const { contract_id: _ignoredId, matrix_cell: _ignoredCell, ...rest } = contract;
  return digest(rest);
}

/**
 * 矩阵格子键：`exam|domain|knowledge_point|problem_type|difficulty`。
 * v0.1 一个契约只落一个格子，多知识点取第一个（保守且可预测）。
 * @param {object} contract
 * @returns {string}
 */
export function matrixCellKey(contract) {
  const source = isPlainObject(contract) ? contract : {};
  const knowledgePoints = asArray(source.knowledge_points);
  const knowledgePoint = knowledgePoints.length > 0 ? String(knowledgePoints[0]) : 'UNKNOWN';
  return [
    asString(source.exam, 'custom'),
    asString(source.domain, 'other'),
    knowledgePoint,
    asString(source.problem_type, 'computation'),
    asString(source.difficulty, 'medium'),
  ].join('|');
}

/** 契约摘要（给工具返回值与日志用，不含全文）。 */
export function contractSummary(contract) {
  if (!isPlainObject(contract)) return null;
  return {
    contract_id: contract.contract_id ?? null,
    exam: contract.exam ?? null,
    domain: contract.domain ?? null,
    knowledge_points: asArray(contract.knowledge_points),
    problem_type: contract.problem_type ?? null,
    difficulty: contract.difficulty ?? null,
    answer_format: contract.answer_format?.type ?? null,
    total_points: contract.grading_rubric?.total_points ?? null,
    time_budget_s: contract.time_budget_s ?? null,
    ambiguity: contract.ambiguity?.severity ?? null,
    in_syllabus: contract.syllabus?.in_syllabus !== false,
    matrix_cell: contract.matrix_cell ?? null,
  };
}

function issue(code, level, message) {
  return { code, level, message };
}

/**
 * 校验并规范化契约（不落盘）。
 * @param {unknown} raw
 * @returns {{ok: boolean, issues: object[], contract: object, state: 'invalid'|'ambiguous'|'out_of_syllabus'|'ready'}}
 */
export function validateContract(raw) {
  const issues = [];
  const source = isPlainObject(raw) ? raw : {};
  const contract = normalizeContract(source);

  if (source.schema !== CONTRACT_SCHEMA) {
    issues.push(issue('SCHEMA', 'error', `schema 必须是 "${CONTRACT_SCHEMA}"`));
  }
  if (contract.problem.text.trim() === '') {
    issues.push(issue('PROBLEM_TEXT', 'error', 'problem.text 不能为空'));
  }
  if (!EXAMS.includes(contract.exam)) {
    issues.push(issue('EXAM', 'error', `exam 不在枚举内: ${contract.exam}`));
  }
  if (!DOMAINS.includes(contract.domain)) {
    issues.push(issue('DOMAIN', 'error', `domain 不在枚举内: ${contract.domain}`));
  }
  if (!PROBLEM_TYPES.includes(contract.problem_type)) {
    issues.push(issue('TYPE', 'error', `problem_type 不在枚举内: ${contract.problem_type}`));
  }
  if (!GOAL_KINDS.includes(contract.goal.kind)) {
    issues.push(issue('GOAL', 'error', `goal.kind 不在枚举内: ${contract.goal.kind}`));
  }
  if (!ANSWER_TYPES.includes(contract.answer_format.type)) {
    issues.push(issue('TYPE', 'error', `answer_format.type 不在枚举内: ${contract.answer_format.type}`));
  }
  if (!RUBRIC_SOURCES.includes(contract.grading_rubric.source)) {
    issues.push(issue('RUBRIC_SOURCE', 'error', `grading_rubric.source 不在枚举内: ${contract.grading_rubric.source}`));
  }
  if (!DIFFICULTIES.includes(contract.difficulty)) {
    issues.push(issue('DIFFICULTY', 'error', `difficulty 不在枚举内: ${contract.difficulty}`));
  }

  if (contract.knowledge_points.length === 0) {
    issues.push(issue('KP_EMPTY', 'error', 'knowledge_points 至少需要 1 个知识点 ID'));
  }
  for (const kp of contract.knowledge_points) {
    if (!KNOWLEDGE_POINT_PATTERN.test(kp)) {
      issues.push(issue('KP_FORMAT', 'warning', `知识点 ID 格式不合规: ${kp}`));
    }
  }

  const rubric = contract.grading_rubric;
  const stepSum = rubric.step_points.reduce((sum, step) => sum + (Number.isFinite(step.points) ? step.points : 0), 0);
  const expected = stepSum + rubric.answer_points;
  if (!Number.isFinite(rubric.total_points) || Math.abs(expected - rubric.total_points) > 0.001) {
    issues.push(issue(
      'POINTS_SUM',
      'error',
      `步骤分 ${stepSum} + 答案分 ${rubric.answer_points} 与总分 ${rubric.total_points} 不一致`,
    ));
  }

  const seenStepIds = new Set();
  for (const step of rubric.step_points) {
    if (step.id.trim() === '' || step.desc.trim() === '' || !Number.isFinite(step.points) || step.points < 0) {
      issues.push(issue('STEP_EMPTY', 'error', `步骤 "${step.id || '(无 id)'}" 缺少 id/desc 或分值非法`));
    }
    if (seenStepIds.has(step.id)) {
      issues.push(issue('STEP_DUP', 'error', `步骤 id 重复: ${step.id}`));
    }
    seenStepIds.add(step.id);
    for (const kind of step.evidence) {
      if (!EVIDENCE_KINDS.includes(kind)) {
        issues.push(issue('EVIDENCE_KIND', 'error', `步骤 ${step.id} 的证据种类非法: ${kind}`));
      }
    }
    if (!PARTIAL_MODES.includes(step.partial)) {
      issues.push(issue('PARTIAL_MODE', 'warning', `步骤 ${step.id} 的 partial 非法: ${step.partial}`));
    }
  }

  if (contract.answer_format.type === 'numerical' && contract.answer_format.tolerance === null) {
    issues.push(issue('TOLERANCE', 'error', 'numerical 答案必须给出 tolerance（abs 或 rel）'));
  }
  if (contract.problem_type === 'proof' && contract.answer_format.type !== 'proof') {
    issues.push(issue('PROOF_FORMAT', 'warning', '证明题的 answer_format.type 建议为 proof'));
  }
  if (contract.ambiguity.severity === 'blocking') {
    issues.push(issue('AMBIGUITY', 'warning', '题目存在阻断性歧义，应先向用户澄清'));
  } else if (!AMBIGUITY_SEVERITIES.includes(contract.ambiguity.severity)) {
    issues.push(issue('AMBIGUITY', 'warning', `ambiguity.severity 不在枚举内: ${contract.ambiguity.severity}`));
  }
  if (!contract.syllabus.in_syllabus || contract.syllabus.out_of_syllabus.length > 0) {
    issues.push(issue('OUT_OF_SYLLABUS', 'warning', '题目涉及大纲外内容'));
  }
  if (!(contract.time_budget_s > 0)) {
    issues.push(issue('BUDGET', 'error', 'time_budget_s 必须大于 0'));
  }

  const hasError = issues.some((item) => item.level === 'error');
  let state;
  if (hasError) state = 'invalid';
  else if (contract.ambiguity.severity === 'blocking') state = 'ambiguous';
  else if (!contract.syllabus.in_syllabus || contract.syllabus.out_of_syllabus.length > 0) state = 'out_of_syllabus';
  else state = 'ready';

  return { ok: state !== 'invalid', issues, contract, state };
}
