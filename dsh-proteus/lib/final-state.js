/**
 * §2.9 五态判定（finalize 与 audit 语义校验共用）。
 *
 * 单独成模块是为了避免 tools.js ↔ audit.js 循环依赖：
 * audit.verifyBundle 需要按同样规则重算终态，tools.finalize 需要产出终态。
 */

import { validateContract } from './contract.js';
import { checkAnswerFormat, summarizeEvidence } from './evidence.js';

/**
 * 按 §2.9 判定终态（不读写磁盘，纯函数）。
 * @param {{contract: object, solution: object, evidence: object[], gradeResult: object, budgetState: object|null, evidenceMinKinds?: number}} input
 * @returns {{state: string, reason_codes: string[]}}
 */
export function decideFinalState({
  contract,
  solution,
  evidence,
  gradeResult,
  budgetState,
  evidenceMinKinds = 2,
} = {}) {
  const contractState = validateContract(contract).state;
  const summary = summarizeEvidence(evidence);
  const traps = Array.isArray(gradeResult?.traps) ? gradeResult.traps : [];
  const formatEvidence = (evidence ?? []).find((item) => item && item.check === 'answer_format' && item.claim === 'answer');
  const formatPass = formatEvidence
    ? formatEvidence.status === 'pass'
    : checkAnswerFormat(contract, solution ?? {}).status === 'pass';
  const unresolved = traps.filter((trap) => trap.basis === 'rule' && (trap.severity === 'blocker' || trap.severity === 'major'));
  const independent = summary.independent_kinds;
  const budgetExhausted = budgetState?.phase === 'exhausted';

  if (contractState === 'ambiguous') return { state: 'Ambiguous', reason_codes: ['CONTRACT_AMBIGUOUS'] };
  if (contractState === 'out_of_syllabus') return { state: 'OutOfSyllabus', reason_codes: ['OUT_OF_SYLLABUS'] };
  if (!hasAnswer(solution)) return { state: 'Unknown', reason_codes: ['NO_ANSWER'] };

  const reasons = [];
  if (summary.fail > 0) reasons.push('EVIDENCE_CONFLICT');
  if (independent.length < evidenceMinKinds) reasons.push('EVIDENCE_INSUFFICIENT');
  if (!formatPass) reasons.push('FORMAT_MISMATCH');
  if (unresolved.length > 0) reasons.push('TRAP_UNRESOLVED');

  const proofProblem = contract?.problem_type === 'proof' || contract?.answer_format?.type === 'proof';
  const formalEvidence = independent.includes('formal') || independent.includes('human');
  const proofGate = !proofProblem || formalEvidence;
  const verifiedCandidate = independent.length >= evidenceMinKinds
    && formatPass
    && unresolved.length === 0
    && summary.fail === 0
    && proofGate;
  if (verifiedCandidate) {
    if (budgetExhausted) return { state: 'LowConfidence', reason_codes: ['TIME_EXHAUSTED'] };
    return { state: 'Verified', reason_codes: [] };
  }
  if (budgetExhausted) reasons.push('TIME_EXHAUSTED');
  if (!proofGate) reasons.push('FORMAL_EVIDENCE_REQUIRED');
  if (summary.total === 0 && !formatPass) {
    return { state: 'Unknown', reason_codes: [...new Set(reasons)] };
  }
  return { state: 'LowConfidence', reason_codes: [...new Set(reasons)] };
}

/**
 * 应用 GRADE_DRIFT：与账本既有 grade 不一致时，Verified 降级并追加 reason。
 * @param {{state: string, reason_codes: string[]}} decision
 * @param {boolean} gradeDrift
 */
export function applyGradeDrift(decision, gradeDrift) {
  if (!gradeDrift) return {
    state: decision.state,
    reason_codes: [...decision.reason_codes],
  };
  const reasons = [...decision.reason_codes];
  if (!reasons.includes('GRADE_DRIFT')) reasons.push('GRADE_DRIFT');
  return {
    state: decision.state === 'Verified' ? 'LowConfidence' : decision.state,
    reason_codes: reasons,
  };
}

/** 终态判定 + drift 合并（finalize 与 audit 校验共用）。 */
export function finalStateFor(input, gradeDrift = false) {
  return applyGradeDrift(decideFinalState(input), gradeDrift);
}

export function hasAnswer(solution) {
  const answer = solution?.answer;
  if (!answer || typeof answer !== 'object') return false;
  const value = answer.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}
