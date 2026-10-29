import test from 'node:test';
import assert from 'node:assert/strict';
import { appendCheckpoint, checkBudget, DEFAULT_THRESHOLDS, startBudget } from '../lib/budget.js';

const AT = new Date('2026-01-01T00:00:00.000Z');

function budgetAt(ratio) {
  const budget = startBudget({ time_budget_s: 1000 }, AT);
  const check = checkBudget(budget, new Date(AT.getTime() + (1 - ratio) * 1000 * 1000));
  return check;
}

test('budget：起表用契约预算，非法时回退 900', () => {
  const budget = startBudget({ time_budget_s: 600 }, AT);
  assert.equal(budget.budget_s, 600);
  assert.equal(budget.started_at, AT.toISOString());
  assert.equal(budget.stage, 'solve');
  assert.deepEqual(budget.checkpoints, []);
  assert.equal(startBudget({ time_budget_s: 0 }, AT).budget_s, 900);
  assert.equal(startBudget({}, AT).budget_s, 900);
});

test('budget：四相位边界与 allow 标志', () => {
  const cases = [
    [0.7, 'explore', true, true],
    [0.6001, 'explore', true, true],
    [0.6, 'converge', true, false],
    [0.35, 'converge', true, false],
    [0.3, 'converge', true, false],
    [0.2999, 'salvage', true, false],
    [0.11, 'salvage', true, false],
    [0.1, 'exhausted', false, false],
    [0.05, 'exhausted', false, false],
    [0, 'exhausted', false, false],
  ];
  for (const [ratio, phase, allowVerified, allowNewSearch] of cases) {
    const state = budgetAt(ratio);
    assert.equal(state.phase, phase, `ratio=${ratio}`);
    assert.equal(state.allow_verified, allowVerified);
    assert.equal(state.allow_new_search, allowNewSearch);
    assert.equal(state.add_search, allowNewSearch);
    assert.equal(typeof state.recommended, 'string');
    assert.ok(Math.abs(state.ratio - ratio) < 1e-3);
  }
});

test('budget：elapsed/remaining 计算与超时钳制', () => {
  const budget = startBudget({ time_budget_s: 100 }, AT);
  const half = checkBudget(budget, new Date(AT.getTime() + 50_000));
  assert.equal(half.elapsed_s, 50);
  assert.equal(half.remaining_s, 50);
  assert.equal(half.ratio, 0.5);
  const late = checkBudget(budget, new Date(AT.getTime() + 150_000));
  assert.equal(late.remaining_s, -50);
  assert.equal(late.ratio, 0);
  assert.equal(late.phase, 'exhausted');
});

test('budget：自定义阈值', () => {
  const budget = startBudget({ time_budget_s: 100 }, AT);
  const state = checkBudget(budget, new Date(AT.getTime() + 50_000), { explore: 0.9, converge: 0.5, salvage: 0.2 });
  assert.equal(state.phase, 'converge');
});

test('budget：appendCheckpoint 追加并更新 stage', () => {
  const budget = startBudget({ time_budget_s: 100 }, AT);
  const state = checkBudget(budget, new Date(AT.getTime() + 10_000));
  const checkpoint = appendCheckpoint(budget, state, 'verify');
  assert.deepEqual(checkpoint, { at_s: 10, stage: 'verify', remaining_s: 90 });
  assert.equal(budget.stage, 'verify');
  assert.equal(budget.checkpoints.length, 1);
  const again = appendCheckpoint(budget, state);
  assert.equal(again.stage, 'verify');
  assert.equal(budget.checkpoints.length, 2);
  assert.equal(DEFAULT_THRESHOLDS.explore, 0.6);
});
