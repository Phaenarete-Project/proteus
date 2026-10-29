/**
 * 评分模拟：按 rubric 与证据预测得分。
 *
 * 规则分是 canonical，LLM 只做解释。所有计分都可由 `contract + solution + evidence`
 * 确定性地复算，这是 finalize 检测 GRADE_DRIFT 的基础。
 */

import { canonicalJson, clamp, roundHalf, roundTo, sha256Hex } from './canonical.js';
import { checkAnswerFormat, summarizeEvidence } from './evidence.js';
import { detectTraps } from './traps.js';

export const RULE_VERSION = 'proteus-rubric/v1';
export const GRADE_SCHEMA = 'proteus.grade/v1';

const EVIDENCE_KIND_SET = new Set(['structural', 'numeric', 'symbolic', 'formal', 'human']);

function passKindsOf(items) {
  const kinds = new Set();
  for (const item of items) {
    if (item && item.status === 'pass' && typeof item.kind === 'string') kinds.add(item.kind);
  }
  return kinds;
}

function scoreStep({ step, solutionStep, evidence }) {
  const text = typeof solutionStep?.text === 'string' ? solutionStep.text.trim() : '';
  const max = Number.isFinite(step.points) ? Math.max(0, step.points) : 0;
  const referenced = new Set(Array.isArray(solutionStep?.evidence_refs) ? solutionStep.evidence_refs.map(String) : []);
  const stepEvidence = evidence.filter((item) => item && (item.claim === step.id || referenced.has(item.evidence_id)));

  if (text === '') {
    return { id: step.id, earned: 0, max, reason: 'step text missing', verified: false, kinds: [] };
  }
  if (stepEvidence.some((item) => item.status === 'fail')) {
    return { id: step.id, earned: 0, max, reason: 'evidence conflict (fail)', verified: false, kinds: [] };
  }

  const kinds = stepEvidence.filter((item) => item.status === 'pass');
  const passedKinds = passKindsOf(kinds);
  const requiredKinds = (Array.isArray(step.evidence) ? step.evidence : []).filter((kind) => EVIDENCE_KIND_SET.has(kind));

  const satisfied = requiredKinds.filter((kind) => (kind === 'structural' ? text !== '' : passedKinds.has(kind)));
  const full = satisfied.length === requiredKinds.length;

  if (full) {
    return {
      id: step.id,
      earned: max,
      max,
      reason: requiredKinds.length > 0
        ? `evidence ${requiredKinds.join(',')} pass`
        : 'step text present',
      verified: true,
      kinds: satisfied,
    };
  }

  if (step.required !== true) {
    // 非必需步骤：文字存在即可得分，不因缺少证据降级（spec 规则 1 只约束 required=true），
    // 但 coverage 只统计 requiredKinds 全部满足的步骤（M10）。
    return { id: step.id, earned: max, max, reason: 'optional step text present', verified: false, kinds: satisfied };
  }

  const independentRequired = requiredKinds.filter((kind) => kind !== 'structural');
  const independentSatisfied = independentRequired.filter((kind) => passedKinds.has(kind));
  const partial = step.partial ?? 'all_or_nothing';
  let earned = 0;
  if (partial === 'half_on_missing') earned = 0.5 * max;
  else if (partial === 'proportional') {
    earned = independentRequired.length > 0
      ? 0.5 * max * (independentSatisfied.length / independentRequired.length)
      : 0.5 * max;
  }
  earned = clamp(earned, 0, max);
  return {
    id: step.id,
    earned,
    max,
    reason: `partial ${partial}: ${satisfied.length}/${requiredKinds.length} required kinds`,
    // M10：部分满足不等于 verified；coverage/confidence 只认 requiredKinds 全满足。
    verified: false,
    kinds: satisfied,
  };
}

/**
 * 按 rubric 预测得分。
 * @param {{contract: object, solution: object, evidence?: object[]}} input
 * @returns {object} GradePrediction（schema `proteus.grade/v1`）
 */
export function grade({ contract, solution, evidence } = {}) {
  if (!contract || typeof contract !== 'object') throw new TypeError('grade 需要 contract');
  const list = Array.isArray(evidence) ? evidence.filter((item) => item && typeof item === 'object') : [];
  const rubric = contract.grading_rubric ?? { total_points: 0, answer_points: 0, step_points: [] };
  const maxPoints = Number.isFinite(rubric.total_points) ? Math.max(0, rubric.total_points) : 0;
  const steps = Array.isArray(rubric.step_points) ? rubric.step_points : [];
  const solutionSteps = Array.isArray(solution?.steps) ? solution.steps : [];
  const solutionById = new Map();
  for (const step of solutionSteps) {
    if (step && typeof step.id === 'string') solutionById.set(step.id, step);
  }

  const stepScores = steps.map((step) => scoreStep({
    step,
    solutionStep: solutionById.get(step.id),
    evidence: list,
  }));

  // 答案分：格式合法 +（契约给了 reference/equation 时，至少一个独立证据 pass）
  const formatResult = checkAnswerFormat(contract, solution ?? {});
  const formatEvidence = list.find((item) => item.check === 'answer_format' && item.claim === 'answer');
  const formatPass = formatEvidence ? formatEvidence.status === 'pass' : formatResult.status === 'pass';
  const verification = contract.verification ?? null;
  const hasReference = Boolean(verification && (
    (typeof verification.reference_expr === 'string' && verification.reference_expr.trim() !== '')
    || (Array.isArray(verification.equations) && verification.equations.length > 0)
  ));
  const independentPass = list.some((item) => item.claim === 'answer' && item.status === 'pass' && item.kind !== 'structural');
  const answerPointsMax = Number.isFinite(rubric.answer_points) ? Math.max(0, rubric.answer_points) : 0;
  const answerPoints = formatPass && (!hasReference || independentPass) ? answerPointsMax : 0;

  const traps = detectTraps({ contract, solution: solution ?? {}, evidence: list });
  const deductionRules = Array.isArray(rubric.deduction_rules) ? rubric.deduction_rules : [];
  const deductions = [];
  let deductionSum = 0;
  for (const finding of traps) {
    if (finding.basis !== 'rule') continue;
    const rule = deductionRules.find((item) => item && item.trap === finding.trap && Number.isFinite(item.deduct));
    const points = Math.max(0, rule ? rule.deduct : Number.isFinite(finding.deduct) ? finding.deduct : 0);
    if (points <= 0) continue;
    deductionSum += points;
    deductions.push({
      trap: finding.trap,
      points,
      reason: `${finding.severity} rule finding: ${finding.detail}`,
    });
  }
  deductionSum = Math.min(deductionSum, maxPoints);

  const stepSum = stepScores.reduce((sum, item) => sum + item.earned, 0);
  const predicted = clamp(roundHalf(stepSum + answerPoints - deductionSum), 0, maxPoints);

  const stepsVerified = stepScores.filter((item) => item.verified).length;
  const coverageRatio = steps.length > 0 ? stepsVerified / steps.length : 0;
  const independentKinds = summarizeEvidence(list).independent_kinds;
  const majorCount = traps.filter((finding) => finding.severity === 'major').length;
  const confidence = roundTo(clamp(
    0.5 + 0.4 * coverageRatio + 0.1 * (independentKinds.length / 3) - 0.15 * majorCount,
    0,
    1,
  ), 2);

  const predictionId = `gp_${sha256Hex(`${contract.contract_id ?? ''}|${canonicalJson(solution ?? null)}|${RULE_VERSION}`).slice(0, 12)}`;

  return {
    schema: GRADE_SCHEMA,
    prediction_id: predictionId,
    contract_id: contract.contract_id ?? null,
    rule_version: RULE_VERSION,
    max_points: maxPoints,
    predicted_points: predicted,
    answer_points: answerPoints,
    step_scores: stepScores.map(({ id, earned, max, reason, kinds }) => ({ id, earned, max, reason, kinds })),
    deductions,
    traps,
    coverage: { steps_verified: stepsVerified, steps_total: steps.length },
    independent_kinds: independentKinds,
    confidence,
    notes: [],
  };
}
