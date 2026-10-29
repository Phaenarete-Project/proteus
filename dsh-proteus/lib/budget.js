/**
 * 时间预算：四相位与降级策略。
 *
 * ratio = remaining / budget：
 *   > 0.6            explore   可多策略并行
 *   0.3 – 0.6        converge  收敛最佳候选并验证
 *   0.1 – 0.3        salvage   只补已有证据的可得分步骤
 *   ≤ 0.1            exhausted 输出当前最佳，标低置信
 */

import { toIsoString } from './store.js';

export const DEFAULT_THRESHOLDS = Object.freeze({ explore: 0.6, converge: 0.3, salvage: 0.1 });

/**
 * 从契约起表。
 * @param {object} contract
 * @param {Date|string|number} [now]
 * @returns {object} Budget
 */
export function startBudget(contract, now = new Date()) {
  const budgetSeconds = Number.isFinite(contract?.time_budget_s) && contract.time_budget_s > 0
    ? contract.time_budget_s
    : 900;
  return {
    started_at: toIsoString(now),
    budget_s: budgetSeconds,
    stage: 'solve',
    checkpoints: [],
  };
}

function resolveThresholds(thresholds) {
  const source = thresholds && typeof thresholds === 'object' ? thresholds : {};
  return {
    explore: Number.isFinite(source.explore) ? source.explore : DEFAULT_THRESHOLDS.explore,
    converge: Number.isFinite(source.converge) ? source.converge : DEFAULT_THRESHOLDS.converge,
    salvage: Number.isFinite(source.salvage) ? source.salvage : DEFAULT_THRESHOLDS.salvage,
  };
}

/**
 * 计算预算状态（纯函数，不修改 budget）。
 * @param {object} budget
 * @param {Date|string|number} [now]
 * @param {{explore?: number, converge?: number, salvage?: number}} [thresholds]
 */
export function checkBudget(budget, now = new Date(), thresholds = DEFAULT_THRESHOLDS) {
  const limits = resolveThresholds(thresholds);
  const budgetSeconds = Number.isFinite(budget?.budget_s) && budget.budget_s > 0 ? budget.budget_s : 0;
  const startedMs = Date.parse(String(budget?.started_at ?? ''));
  const nowIso = toIsoString(now);
  const nowMs = Date.parse(nowIso);
  const elapsed = Number.isFinite(startedMs) && Number.isFinite(nowMs)
    ? Math.max(0, (nowMs - startedMs) / 1000)
    : 0;
  const remaining = budgetSeconds - elapsed;
  const ratio = budgetSeconds > 0 ? Math.max(0, remaining / budgetSeconds) : 0;

  let phase;
  if (ratio > limits.explore) phase = 'explore';
  else if (ratio >= limits.converge) phase = 'converge';
  else if (ratio > limits.salvage) phase = 'salvage';
  else phase = 'exhausted';

  const allowVerified = phase !== 'exhausted';
  const allowNewSearch = phase === 'explore';
  const recommended = {
    explore: '时间充裕：可多策略并行探索，优先补齐证据种类',
    converge: '时间过半：收敛最佳候选，继续验证已有步骤',
    salvage: '时间紧张：只补可得分步骤，停止新探索',
    exhausted: '时间耗尽：输出当前最佳答案并标低 Confidence',
  }[phase];

  return {
    elapsed_s: Math.round(elapsed * 1000) / 1000,
    remaining_s: Math.round(remaining * 1000) / 1000,
    ratio: Math.round(ratio * 1e6) / 1e6,
    phase,
    allow_verified: allowVerified,
    allow_new_search: allowNewSearch,
    add_search: allowNewSearch,
    recommended,
  };
}

/** 追加 checkpoint（修改 budget 并返回新条目；工具层负责落盘）。 */
export function appendCheckpoint(budget, state, stage) {
  if (!budget || typeof budget !== 'object') throw new TypeError('appendCheckpoint 需要 budget');
  const checkpoint = {
    at_s: Math.round(state.elapsed_s),
    stage: typeof stage === 'string' && stage.trim() !== '' ? stage : budget.stage ?? 'solve',
    remaining_s: Math.round(state.remaining_s),
  };
  const checkpoints = Array.isArray(budget.checkpoints) ? budget.checkpoints.slice() : [];
  checkpoints.push(checkpoint);
  budget.checkpoints = checkpoints;
  if (stage) budget.stage = checkpoint.stage;
  return checkpoint;
}
