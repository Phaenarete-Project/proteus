/**
 * 审计包：可重放证据链的打包与校验。
 *
 * verifyBundle 分两层：
 * - 结构层（verifyBundleStructure）：bundle_id、时间线哈希链、证据字段/摘要、评分形状、state 枚举。
 * - 语义层（verifyBundleSemantics）：validateContract 状态相容、按 bundle.verification.plan/seed
 *   重跑 checks 并逐条比对证据、用重跑证据重算 grade、重算 §2.9 五态、悬空 refs、
 *   budget exhausted 不得 Verified。
 *
 * 语义层只依赖 bundle 自身，不读工作区、不联网。replay 复用同一套语义重算。
 */

import { canonicalJson, digest } from './canonical.js';
import { contractDigest, matrixCellKey, validateContract } from './contract.js';
import { buildPlan, CHECK_IDS, runChecks, validateEvidenceRecord } from './evidence.js';
import { finalStateFor } from './final-state.js';
import { checkBudget } from './budget.js';
import { grade, RULE_VERSION } from './rubric.js';
import { auditPath, currentEvidence, readJsonStrict, toIsoString, writeJsonAtomic, codedError } from './store.js';

export const AUDIT_SCHEMA = 'proteus.audit/v1';
export const FINAL_STATES = ['Verified', 'LowConfidence', 'Unknown', 'Ambiguous', 'OutOfSyllabus'];
export const REASON_CODES = [
  'EVIDENCE_INSUFFICIENT',
  'EVIDENCE_CONFLICT',
  'FORMAT_MISMATCH',
  'TRAP_UNRESOLVED',
  'TIME_EXHAUSTED',
  'NO_ANSWER',
  'CONTRACT_AMBIGUOUS',
  'OUT_OF_SYLLABUS',
  'GRADE_DRIFT',
  'FORMAL_EVIDENCE_REQUIRED',
];

const EVIDENCE_KINDS = new Set(['structural', 'numeric', 'symbolic', 'formal', 'human']);
const EVIDENCE_STATUS = new Set(['pass', 'fail', 'unknown']);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const EVIDENCE_ID_RE = /^ev_[0-9a-f]{12}$/;
const PREDICTION_ID_RE = /^gp_[0-9a-f]{12}$/;

const CONTRACT_STATE_COMPAT = {
  ready: new Set(['Verified', 'LowConfidence', 'Unknown']),
  ambiguous: new Set(['Ambiguous']),
  out_of_syllabus: new Set(['OutOfSyllabus']),
  invalid: new Set(),
};

function issue(code, message, level = 'error') {
  return { code, level, message };
}

function sameNumber(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9;
}

function sameJson(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * 构造审计包（不落盘）。
 * @param {{ledger: object, matrixBefore?: object, environment?: object, at?: string|Date}} input
 */
export function buildBundle({ ledger, matrixBefore, environment, at } = {}) {
  if (!ledger || typeof ledger !== 'object' || !ledger.contract) throw new TypeError('buildBundle 需要带 contract 的 ledger');
  const atIso = toIsoString(at);
  const contract = ledger.contract;
  const final = ledger.final && typeof ledger.final === 'object' ? ledger.final : null;
  const solution = final?.solution ?? null;
  const gradeValue = final?.grade ?? ledger.grade ?? null;
  const state = final
    ? { state: final.state ?? 'Unknown', reason_codes: Array.isArray(final.reason_codes) ? final.reason_codes : [], decided_at: final.decided_at ?? atIso }
    : { state: 'Unknown', reason_codes: [], decided_at: atIso };
  let budget = null;
  if (ledger.budget && typeof ledger.budget === 'object') {
    const check = final?.budget_check ?? checkBudget(ledger.budget, atIso);
    budget = { ...ledger.budget, phase: check?.phase ?? null, check };
  }
  const verification = ledger.verification && typeof ledger.verification === 'object'
    ? {
      attempt: Number.isFinite(ledger.verification.attempt) ? ledger.verification.attempt : null,
      plan: Array.isArray(ledger.verification.plan) ? ledger.verification.plan.map(String) : [],
      seed: Number.isFinite(ledger.verification.seed) ? ledger.verification.seed : null,
    }
    : null;

  const bundle = {
    schema: AUDIT_SCHEMA,
    contract,
    solution,
    evidence: currentEvidence(ledger).map((item) => ({ ...item })),
    grade: gradeValue,
    verification,
    state,
    budget,
    environment: environment && typeof environment === 'object' ? { ...environment } : defaultEnvironment(contract),
    grade_drift: final?.grade_drift === true,
    timeline: Array.isArray(ledger.timeline) ? ledger.timeline.map((entry) => ({ ...entry })) : [],
  };
  void matrixBefore;
  bundle.bundle_id = bundleDigest(bundle);
  return bundle;
}

export function defaultEnvironment(contract, extra = {}) {
  return {
    plugin_version: '0.1.0',
    node: process.version,
    platform: process.platform,
    model: 'unknown',
    seed: Number.isFinite(contract?.verification?.seed) ? contract.verification.seed : null,
    rule_version: RULE_VERSION,
    evidence_min_kinds: 2,
    ...extra,
  };
}

function bundleDigest(bundle) {
  const { bundle_id: _ignored, ...rest } = bundle;
  return digest(rest);
}

/**
 * 写审计包到 `<root>/audit/<hex>.json`。
 * @returns {string} 绝对路径
 */
export function writeBundle(rootDir, bundle) {
  if (!bundle || !bundle.contract || typeof bundle.contract.contract_id !== 'string') {
    throw codedError('BUNDLE_INVALID', 'writeBundle 需要带 contract.contract_id 的 bundle');
  }
  const path = auditPath(rootDir, bundle.contract.contract_id);
  writeJsonAtomic(path, bundle);
  return path;
}

/** 读审计包：缺失 null，损坏抛 BUNDLE_CORRUPT。 */
export function readBundle(path) {
  try {
    const value = readJsonStrict(path);
    if (value === null) return null;
    if (!value || typeof value !== 'object' || !value.contract) {
      throw codedError('BUNDLE_CORRUPT', `审计包结构不完整 ${path}`);
    }
    return value;
  } catch (error) {
    if (error?.code === 'JSON_CORRUPT') throw codedError('BUNDLE_CORRUPT', error.message);
    if (error?.code === 'BUNDLE_CORRUPT') throw error;
    throw codedError('BUNDLE_CORRUPT', `读取审计包失败 ${path}: ${error?.message ?? error}`);
  }
}

/**
 * 按 bundle.verification.plan/seed 重跑 checks（replay 与 verify 语义层共用）。
 * @returns {{plan: object[], seed: number, evidence: object[]}}
 */
export function rerunBundleChecks(bundle) {
  const contract = bundle?.contract ?? {};
  const allPlan = buildPlan(contract);
  const requested = Array.isArray(bundle?.verification?.plan) ? bundle.verification.plan : null;
  const plan = requested
    ? allPlan.filter((check) => requested.includes(check.id))
    : allPlan;
  const seed = Number.isFinite(bundle?.verification?.seed)
    ? bundle.verification.seed
    : Number.isFinite(contract?.verification?.seed)
      ? contract.verification.seed
      : 42;
  const solution = bundle?.solution ?? {};
  return { plan, seed, evidence: runChecks({ contract, plan, solution, seed }) };
}

function verifyTimeline(timeline, issues) {
  if (!Array.isArray(timeline)) {
    issues.push(issue('TIMELINE_MISSING', 'timeline 必须是数组'));
    return;
  }
  let previous = null;
  for (let index = 0; index < timeline.length; index += 1) {
    const entry = timeline[index];
    if (!entry || typeof entry !== 'object') {
      issues.push(issue('TIMELINE_ENTRY', `timeline[${index}] 不是对象`));
      continue;
    }
    if (entry.seq !== index + 1) {
      issues.push(issue('TIMELINE_SEQ', `timeline[${index}].seq 应为 ${index + 1}，实际 ${entry.seq}`));
    }
    if (entry.prev !== previous) {
      issues.push(issue('TIMELINE_CHAIN', `timeline[${index}].prev 与上一条 hash 不一致`));
    }
    if (typeof entry.event !== 'string' || entry.event === '') {
      issues.push(issue('TIMELINE_EVENT', `timeline[${index}].event 为空`));
    }
    if (!Number.isFinite(Date.parse(String(entry.at ?? '')))) {
      issues.push(issue('TIMELINE_TIME', `timeline[${index}].at 不是合法时间`));
    }
    const expected = digest({ seq: entry.seq, at: entry.at, event: entry.event, prev: entry.prev });
    if (entry.hash !== expected) {
      issues.push(issue('TIMELINE_HASH', `timeline[${index}].hash 校验失败`));
    }
    previous = entry.hash;
  }
}

function verifyEvidenceStructure(bundle, issues) {
  const evidence = bundle.evidence;
  if (!Array.isArray(evidence)) {
    issues.push(issue('EVIDENCE_MISSING', 'evidence 必须是数组'));
    return;
  }
  const solution = bundle.solution;
  const seed = Number.isFinite(bundle?.verification?.seed)
    ? bundle.verification.seed
    : bundle?.contract?.verification?.seed;
  const stepIds = new Set(
    Array.isArray(solution?.steps)
      ? solution.steps.filter((step) => step && typeof step.id === 'string').map((step) => step.id)
      : [],
  );
  for (let index = 0; index < evidence.length; index += 1) {
    const item = evidence[index];
    const label = `evidence[${index}]`;
    if (!item || typeof item !== 'object') {
      issues.push(issue('EVIDENCE_SHAPE', `${label} 不是对象`));
      continue;
    }
    if (!EVIDENCE_ID_RE.test(String(item.evidence_id ?? ''))) {
      issues.push(issue('EVIDENCE_SHAPE', `${label}.evidence_id 非法`));
    }
    if (!EVIDENCE_KINDS.has(item.kind)) {
      issues.push(issue('EVIDENCE_KIND', `${label}.kind 非法: ${item.kind}`));
    }
    if (!CHECK_IDS.includes(item.check)) {
      issues.push(issue('EVIDENCE_CHECK', `${label}.check 非法: ${item.check}`));
    }
    if (typeof item.claim !== 'string' || item.claim === '') {
      issues.push(issue('EVIDENCE_CLAIM', `${label}.claim 为空`));
    } else if (item.claim !== 'answer' && !stepIds.has(item.claim)) {
      issues.push(issue('EVIDENCE_CLAIM', `${label}.claim 无法解析: ${item.claim}`));
    }
    if (!EVIDENCE_STATUS.has(item.status)) {
      issues.push(issue('EVIDENCE_STATUS', `${label}.status 非法: ${item.status}`));
    }
    if (typeof item.detail !== 'string') {
      issues.push(issue('EVIDENCE_DETAIL', `${label}.detail 必须是字符串`));
    }
    if (!DIGEST_RE.test(String(item.input_digest ?? ''))) {
      issues.push(issue('EVIDENCE_DIGEST', `${label}.input_digest 格式非法`));
    }
    if (!DIGEST_RE.test(String(item.output_digest ?? ''))) {
      issues.push(issue('EVIDENCE_DIGEST', `${label}.output_digest 格式非法`));
    }
    if (!Number.isFinite(Date.parse(String(item.created_at ?? '')))) {
      issues.push(issue('EVIDENCE_TIME', `${label}.created_at 不是合法时间`));
    }
    for (const recIssue of validateEvidenceRecord(item, { contract: bundle.contract, solution, seed })) {
      issues.push(issue(recIssue.code, `${label}: ${recIssue.message}`));
    }
  }
}

function verifyGradeStructure(gradeValue, contract, evidence, issues) {
  if (!gradeValue || typeof gradeValue !== 'object') {
    issues.push(issue('GRADE_MISSING', 'grade 缺失'));
    return;
  }
  if (gradeValue.schema !== 'proteus.grade/v1') issues.push(issue('GRADE_SCHEMA', `grade.schema 非法: ${gradeValue.schema}`));
  if (gradeValue.rule_version !== RULE_VERSION) {
    issues.push(issue('GRADE_RULE', `grade.rule_version 应为 ${RULE_VERSION}`));
  }
  if (!PREDICTION_ID_RE.test(String(gradeValue.prediction_id ?? ''))) {
    issues.push(issue('GRADE_ID', 'grade.prediction_id 格式非法'));
  }
  if (gradeValue.contract_id !== contract?.contract_id) {
    issues.push(issue('GRADE_CONTRACT', 'grade.contract_id 与契约不一致'));
  }
  const max = Number.isFinite(gradeValue.max_points) ? gradeValue.max_points : null;
  const total = Number.isFinite(contract?.grading_rubric?.total_points) ? contract.grading_rubric.total_points : null;
  if (max === null) issues.push(issue('GRADE_MAX', 'grade.max_points 非法'));
  else if (total !== null && Math.abs(max - total) > 0.001) {
    issues.push(issue('GRADE_MAX', `grade.max_points ${max} 与契约总分 ${total} 不一致`));
  }
  if (!Number.isFinite(gradeValue.predicted_points) || (max !== null && (gradeValue.predicted_points < 0 || gradeValue.predicted_points > max))) {
    issues.push(issue('GRADE_RANGE', 'grade.predicted_points 越界'));
  }
  if (!Array.isArray(gradeValue.step_scores)) issues.push(issue('GRADE_STEPS', 'grade.step_scores 必须是数组'));
  else {
    let stepSum = 0;
    for (const step of gradeValue.step_scores) {
      if (!step || typeof step !== 'object' || typeof step.id !== 'string') {
        issues.push(issue('GRADE_STEPS', 'grade.step_scores 条目非法'));
        continue;
      }
      if (!Number.isFinite(step.earned) || !Number.isFinite(step.max) || step.earned < 0 || step.earned > step.max + 0.001) {
        issues.push(issue('GRADE_STEPS', `步骤 ${step.id} 得分越界`));
      } else stepSum += step.earned;
    }
    if (max !== null && stepSum > max + 0.001) issues.push(issue('GRADE_STEPS', '步骤得分之和超过总分'));
  }
  if (!Array.isArray(gradeValue.deductions)) issues.push(issue('GRADE_DEDUCTIONS', 'grade.deductions 必须是数组'));
  else {
    const sum = gradeValue.deductions.reduce((acc, item) => acc + (Number.isFinite(item?.points) ? Math.max(0, item.points) : 0), 0);
    if (max !== null && sum > max + 0.001) issues.push(issue('GRADE_DEDUCTIONS', '扣分之和超过总分'));
  }
  if (!Array.isArray(gradeValue.traps)) issues.push(issue('GRADE_TRAPS', 'grade.traps 必须是数组'));
  else {
    for (const trap of gradeValue.traps) {
      if (!trap || typeof trap.trap !== 'string' || !/^T\d{2}$/.test(trap.trap)) {
        issues.push(issue('GRADE_TRAPS', 'grade.traps 条目非法'));
        continue;
      }
      if (!['minor', 'major', 'blocker'].includes(trap.severity)) issues.push(issue('GRADE_TRAPS', `陷阱 ${trap.trap} severity 非法`));
      if (!['rule', 'heuristic'].includes(trap.basis)) issues.push(issue('GRADE_TRAPS', `陷阱 ${trap.trap} basis 非法`));
    }
  }
  if (!Array.isArray(gradeValue.independent_kinds)) issues.push(issue('GRADE_EVIDENCE', 'grade.independent_kinds 必须是数组'));
  else {
    for (const kind of gradeValue.independent_kinds) {
      if (!EVIDENCE_KINDS.has(kind) || kind === 'structural') {
        issues.push(issue('GRADE_EVIDENCE', `grade.independent_kinds 含非法种类: ${kind}`));
      }
    }
  }
  if (!gradeValue.coverage || !Number.isFinite(gradeValue.coverage.steps_total) || !Number.isFinite(gradeValue.coverage.steps_verified)) {
    issues.push(issue('GRADE_COVERAGE', 'grade.coverage 非法'));
  }
  if (!Number.isFinite(gradeValue.confidence) || gradeValue.confidence < 0 || gradeValue.confidence > 1) {
    issues.push(issue('GRADE_CONFIDENCE', 'grade.confidence 越界'));
  }
  if (!Array.isArray(evidence)) issues.push(issue('GRADE_EVIDENCE', 'grade 存在但 evidence 不是数组', 'warning'));
}

/**
 * 结构层校验（bundle_id/contract_id/证据摘要/评分形状/timeline/environment）。
 * @returns {object[]} issues
 */
export function verifyBundleStructure(bundle) {
  const issues = [];
  if (!bundle || typeof bundle !== 'object') return [issue('BUNDLE_SHAPE', '审计包必须是对象')];
  if (bundle.schema !== AUDIT_SCHEMA) issues.push(issue('SCHEMA', `schema 必须是 ${AUDIT_SCHEMA}`));
  if (bundle.bundle_id !== bundleDigest(bundle)) {
    issues.push(issue('BUNDLE_ID', 'bundle_id 与内容摘要不一致（疑似篡改）'));
  }
  const contract = bundle.contract;
  if (!contract || typeof contract !== 'object') {
    issues.push(issue('CONTRACT_MISSING', 'contract 缺失'));
  } else {
    if (typeof contract.contract_id !== 'string') issues.push(issue('CONTRACT_ID', 'contract.contract_id 缺失'));
    else if (contract.contract_id !== contractDigest(contract)) {
      issues.push(issue('CONTRACT_ID', 'contract_id 与契约内容摘要不一致（疑似篡改）'));
    }
    if (contract.matrix_cell !== matrixCellKey(contract)) {
      issues.push(issue('CONTRACT_CELL', 'contract.matrix_cell 与契约内容不一致'));
    }
  }
  const solution = bundle.solution;
  if (solution !== null && (typeof solution !== 'object' || !solution.answer || typeof solution.answer !== 'object' || !Array.isArray(solution.steps))) {
    issues.push(issue('SOLUTION_SHAPE', 'solution 结构非法'));
  }
  verifyEvidenceStructure(bundle, issues);
  verifyGradeStructure(bundle.grade, contract, bundle.evidence, issues);
  const state = bundle.state;
  if (!state || typeof state !== 'object') {
    issues.push(issue('STATE_MISSING', 'state 缺失'));
  } else {
    if (!FINAL_STATES.includes(state.state)) issues.push(issue('STATE_VALUE', `state.state 非法: ${state.state}`));
    if (!Array.isArray(state.reason_codes)) issues.push(issue('STATE_REASONS', 'state.reason_codes 必须是数组'));
    else {
      for (const code of state.reason_codes) {
        if (!REASON_CODES.includes(code)) issues.push(issue('STATE_REASONS', `未知 reason code: ${code}`));
      }
    }
    if (!Number.isFinite(Date.parse(String(state.decided_at ?? '')))) {
      issues.push(issue('STATE_TIME', 'state.decided_at 不是合法时间'));
    }
  }
  verifyTimeline(bundle.timeline, issues);
  if (!bundle.environment || typeof bundle.environment !== 'object') {
    issues.push(issue('ENVIRONMENT_MISSING', 'environment 缺失', 'warning'));
  } else if (bundle.environment.rule_version !== RULE_VERSION) {
    issues.push(issue('ENVIRONMENT_RULE', `environment.rule_version 应为 ${RULE_VERSION}`, 'warning'));
  }
  return issues;
}

/**
 * 语义层校验：契约状态相容 + 重跑证据 + 重算 grade + 重算五态 + refs/budget。
 * @returns {object[]} issues
 */
export function verifyBundleSemantics(bundle, options = {}) {
  const issues = [];
  if (!bundle || typeof bundle !== 'object') return issues;
  const evidenceMinKinds = Number.isFinite(options?.evidenceMinKinds) ? Math.max(0, Math.floor(options.evidenceMinKinds)) : 2;
  const declaredMinKinds = bundle.environment?.evidence_min_kinds;
  if (Number.isFinite(declaredMinKinds) && declaredMinKinds !== evidenceMinKinds) {
    issues.push(issue('CONFIG_MISMATCH', `bundle.environment.evidence_min_kinds=${declaredMinKinds} 与调用方配置 ${evidenceMinKinds} 不一致`));
  }
  const contract = bundle.contract;
  const solution = bundle.solution;
  if (!contract || typeof contract !== 'object') return issues;

  const validation = validateContract(contract);
  const contractState = validation.state;
  if (contractState === 'invalid') {
    const details = validation.issues.filter((item) => item.level === 'error').map((item) => `${item.code}:${item.message}`).join('; ');
    issues.push(issue('INVALID_CONTRACT', `contract 无法通过 validateContract（${details}）`));
  } else {
    const allowed = CONTRACT_STATE_COMPAT[contractState] ?? new Set();
    if (!allowed.has(bundle?.state?.state)) {
      issues.push(issue('CONTRACT_STATE_MISMATCH', `契约状态 ${contractState} 与终态 ${bundle?.state?.state} 不相容`));
    }
  }

  if (!solution || typeof solution !== 'object' || !solution.answer || typeof solution.answer !== 'object' || !Array.isArray(solution.steps)) {
    issues.push(issue('SOLUTION_SHAPE', 'solution 缺失或结构非法，无法重算证据'));
    return issues;
  }

  const bundleEvidence = Array.isArray(bundle.evidence) ? bundle.evidence.filter((item) => item && typeof item === 'object') : [];
  const evidenceIds = new Set(bundleEvidence.map((item) => item.evidence_id));
  for (const step of solution.steps) {
    if (!step || !Array.isArray(step.evidence_refs)) continue;
    for (const reference of step.evidence_refs) {
      if (!evidenceIds.has(reference)) {
        issues.push(issue('DANGLING_EVIDENCE_REF', `步骤 ${step.id ?? '(无 id)'} 引用了不存在的证据 ${reference}`));
      }
    }
  }

  const requested = Array.isArray(bundle?.verification?.plan) ? bundle.verification.plan : null;
  if (requested) {
    for (const checkId of requested) {
      if (!CHECK_IDS.includes(checkId)) issues.push(issue('EVIDENCE_PLAN', `bundle.verification.plan 含未知 check: ${checkId}`));
    }
  }
  const rerun = rerunBundleChecks(bundle);
  if (bundleEvidence.length !== rerun.evidence.length) {
    issues.push(issue('EVIDENCE_MISMATCH', `证据数量不一致：bundle ${bundleEvidence.length} 条，重跑 ${rerun.evidence.length} 条`));
  }
  const rerunById = new Map(rerun.evidence.map((item) => [item.evidence_id, item]));
  const bundleById = new Map(bundleEvidence.map((item) => [item.evidence_id, item]));
  for (const [id, expected] of bundleById) {
    const actual = rerunById.get(id);
    if (!actual) {
      issues.push(issue('EVIDENCE_MISMATCH', `bundle 中的证据 ${id} 未被重跑产出`));
      continue;
    }
    if (expected.kind !== actual.kind || expected.status !== actual.status || expected.claim !== actual.claim) {
      issues.push(issue('EVIDENCE_MISMATCH', `证据 ${id} 的 kind/status/claim 与重跑不一致`));
    }
  }
  for (const id of rerunById.keys()) {
    if (!bundleById.has(id)) issues.push(issue('EVIDENCE_EXTRA', `重跑产出的证据 ${id} 不在 bundle 中`));
  }

  if (!bundle.grade || typeof bundle.grade !== 'object') return issues;

  const recomputedGrade = grade({ contract, solution, evidence: rerun.evidence });
  const gradeFields = ['predicted_points', 'max_points', 'answer_points', 'confidence'];
  const mismatched = [];
  for (const field of gradeFields) {
    if (!sameNumber(bundle.grade[field], recomputedGrade[field])) mismatched.push(field);
  }
  if (!sameJson(bundle.grade.step_scores, recomputedGrade.step_scores)) mismatched.push('step_scores');
  if (!sameJson(bundle.grade.deductions, recomputedGrade.deductions)) mismatched.push('deductions');
  if (!sameJson(bundle.grade.coverage, recomputedGrade.coverage)) mismatched.push('coverage');
  if (!sameJson(bundle.grade.independent_kinds, recomputedGrade.independent_kinds)) mismatched.push('independent_kinds');
  if (mismatched.length > 0) {
    issues.push(issue('GRADE_MISMATCH', `用重跑证据重算的 grade 与 bundle.grade 不一致：${mismatched.join(',')}`));
  }

  let budgetState = null;
  if (bundle.budget && Number.isFinite(bundle.budget.budget_s) && Number.isFinite(Date.parse(String(bundle.budget.started_at ?? '')))) {
    budgetState = checkBudget(bundle.budget, bundle.state?.decided_at ?? new Date());
  }
  if (budgetState?.phase === 'exhausted' && bundle.state?.state === 'Verified') {
    issues.push(issue('BUDGET_STATE_CONFLICT', 'budget.phase=exhausted 时 state 不得为 Verified'));
  }
  const decision = finalStateFor({
    contract,
    solution,
    evidence: rerun.evidence,
    gradeResult: recomputedGrade,
    budgetState,
    evidenceMinKinds,
  }, bundle.grade_drift === true);
  const expectedReasons = [...decision.reason_codes].sort();
  const actualReasons = Array.isArray(bundle.state?.reason_codes) ? [...bundle.state.reason_codes].sort() : null;
  if (bundle.state?.state !== decision.state || !sameJson(expectedReasons, actualReasons)) {
    issues.push(issue('STATE_MISMATCH', `重算终态 ${decision.state} ${JSON.stringify(expectedReasons)} 与 bundle.state ${bundle.state?.state} ${JSON.stringify(actualReasons)} 不一致`));
  }
  return issues;
}

/**
 * 完整校验（结构 + 语义）。
 * @returns {{ok: boolean, issues: object[]}}
 */
export function verifyBundle(bundle, options = {}) {
  const structural = verifyBundleStructure(bundle);
  const semantic = bundle && typeof bundle === 'object' ? verifyBundleSemantics(bundle, options) : [];
  const issues = [...structural, ...semantic];
  return { ok: !issues.some((item) => item.level === 'error'), issues };
}
