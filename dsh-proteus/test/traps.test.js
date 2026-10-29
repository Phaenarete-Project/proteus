import test from 'node:test';
import assert from 'node:assert/strict';
import { TRAPS, detectTraps, trapById } from '../lib/traps.js';
import { validateContract } from '../lib/contract.js';
import { makeContract } from './helpers.js';

const BASE_SOLUTION = { answer: { value: '1', unit: null }, steps: [] };

function build(contractOverrides = {}, solutionOverrides = {}) {
  const raw = makeContract(contractOverrides);
  const validated = validateContract(raw);
  const solution = { ...structuredClone(BASE_SOLUTION), ...solutionOverrides };
  return { contract: validated.contract, solution };
}

function idsFor({ contract, solution }, ctx = {}) {
  return new Set(detectTraps({ contract, solution, ...ctx }).map((finding) => finding.trap));
}

const cases = [
  {
    id: 'T01',
    pos: [{}, {}],
    neg: [{}, { steps: [{ id: 'S1', text: 'x', tags: ['domain'] }] }],
  },
  {
    id: 'T02',
    pos: [{ problem: { text: '解 |x-1|=2' } }, {}],
    neg: [{ problem: { text: '解 |x-1|=2' } }, { steps: [{ id: 'S1', text: 'x', tags: ['cases:2'] }] }],
  },
  {
    id: 'T03',
    pos: [{ problem: { text: '求 log(x) 的定义域' } }, {}],
    neg: [{ problem: { text: '求 log(x) 的定义域' } }, { steps: [{ id: 'S1', text: 'x>0', tags: ['domain'] }] }],
  },
  {
    id: 'T04',
    pos: [{ problem: { text: '若 sqrt(x) 有意义' } }, {}],
    neg: [{ problem: { text: '若 sqrt(x) 有意义' } }, { steps: [{ id: 'S1', text: 'x≥0', tags: ['domain'] }] }],
  },
  {
    id: 'T05',
    pos: [{ problem: { text: '求 1/(x-1) 的单调性' } }, {}],
    neg: [{ problem: { text: '求 1/(x-1) 的单调性' } }, { steps: [{ id: 'S1', text: 'x≠1', tags: ['domain'] }] }],
  },
  {
    id: 'T06',
    pos: [{ answer_format: { type: 'exact', units: 'cm^2' } }, {}],
    neg: [{ answer_format: { type: 'exact', units: 'cm^2' } }, { answer: { value: '1', unit: 'cm^2' } }],
  },
  {
    id: 'T07',
    pos: [{ verification: { expected_solution_count: 2 } }, { answer: { value: '1' } }],
    neg: [{ verification: { expected_solution_count: 2 } }, { answer: { value: '1,2' } }],
  },
  {
    id: 'T08',
    pos: [{ givens: [{ id: 'G1', text: '参数 a>0', symbol: 'a', required: true }] }, {}],
    neg: [{ givens: [{ id: 'G1', text: '参数 a>0', symbol: 'a', required: true }] }, { steps: [{ id: 'S1', text: 'a>0', tags: ['param-range'] }] }],
  },
  {
    id: 'T09',
    pos: [
      { answer_format: { type: 'interval', endpoints: { left: 'open', right: 'open' } } },
      { answer: { value: '[0,2]' } },
    ],
    neg: [
      { answer_format: { type: 'interval', endpoints: { left: 'open', right: 'open' } } },
      { answer: { value: '(0,2)' } },
    ],
  },
  {
    id: 'T10',
    pos: [{ goal: { kind: 'prove', statement: '证明 f 单调递增' } }, { steps: [{ id: 'S1', text: '若 A 则 B', tags: ['iff'] }] }],
    neg: [{ goal: { kind: 'prove', statement: '证明 f 单调递增' } }, { steps: [{ id: 'S1', text: '双向', tags: ['iff', 'forward', 'backward'] }] }],
  },
  {
    id: 'T11',
    pos: [
      { goal: { kind: 'prove', statement: 'f 在 R 上单调递增' } },
      { steps: [{ id: 'S1', text: 'f 在 R 上单调递增' }] },
    ],
    neg: [
      { goal: { kind: 'prove', statement: 'f 在 R 上单调递增' } },
      { steps: [{ id: 'S1', text: 'f 在 R 上单调递增', evidence_refs: ['ev_000000000000'] }] },
    ],
  },
  {
    id: 'T12',
    pos: [{}, { steps: [{ id: 'S1', text: '两边平方', tags: ['square-both-sides'] }] }],
    neg: [{}, { steps: [{ id: 'S1', text: '两边平方并检验', tags: ['square-both-sides', 'check:extraneous'] }] }],
  },
  {
    id: 'T13',
    pos: [
      { answer_format: { type: 'numerical', tolerance: { abs: 0.001 } } },
      { answer: { value: '1.41' }, steps: [{ id: 'S1', text: '计算得 ≈1.4142' }, { id: 'S2', text: '答案是 1.41' }] },
    ],
    neg: [
      { answer_format: { type: 'numerical', tolerance: { abs: 0.001 } } },
      { answer: { value: '1.4142' }, steps: [{ id: 'S1', text: '计算得 ≈1.4142' }, { id: 'S2', text: '答案是 1.4142' }] },
    ],
  },
  {
    id: 'T14',
    pos: [{ goal: { kind: 'prove', statement: '证明结论' } }, {}],
    neg: [{ goal: { kind: 'prove', statement: '证明结论' } }, { steps: [{ id: 'S1', text: '证毕', tags: ['conclusion'] }] }],
  },
  {
    id: 'T15',
    pos: [{ problem: { text: '已知 x=1，求值' } }, { steps: [{ id: 'S1', text: '设 t=x^2，则 t+w' }] }],
    neg: [{ problem: { text: '已知 x=1，求值' } }, { steps: [{ id: 'S1', text: '设 t=x^2，则 t+x' }] }],
  },
  {
    id: 'T16',
    pos: [{ distractors: ['1'] }, {}],
    neg: [{ distractors: ['1'] }, { answer: { value: '3' } }],
  },
  {
    id: 'T17',
    pos: [{}, {}],
    neg: [{}, { steps: [{ id: 'S1', text: '使用已知', tags: ['uses:G1'] }] }],
  },
  {
    id: 'T18',
    pos: [{ domain: 'probability' }, {}],
    neg: [{ domain: 'probability' }, { steps: [{ id: 'S1', text: '枚举', tags: ['cases:3'] }] }],
  },
  {
    id: 'T19',
    pos: [{ domain: 'probability', problem: { text: '事件 A 与 B 相互独立，求概率' } }, {}],
    neg: [{ domain: 'probability', problem: { text: '事件 A 与 B 相互独立，求概率' } }, { steps: [{ id: 'S1', text: '相互独立', tags: ['independent'] }] }],
  },
  {
    id: 'T20',
    pos: [{ domain: 'linear_algebra' }, { steps: [{ id: 'S1', text: 'AB=BA' }] }],
    neg: [{ domain: 'linear_algebra' }, { steps: [{ id: 'S1', text: 'AB=C' }] }],
  },
  {
    id: 'T21',
    pos: [{ domain: 'linear_algebra' }, {}, { evidence: [{ kind: 'numeric', status: 'fail' }] }],
    neg: [{ domain: 'linear_algebra' }, {}, {}],
  },
  {
    id: 'T22',
    pos: [{ domain: 'linear_algebra' }, {}],
    neg: [{ domain: 'linear_algebra' }, { steps: [{ id: 'S1', text: 'rank(A)=2', tags: ['rank'] }] }],
  },
  {
    id: 'T23',
    pos: [{ domain: 'series', problem: { text: '判断级数是否收敛' } }, {}],
    neg: [{ domain: 'series', problem: { text: '判断级数是否收敛' } }, { steps: [{ id: 'S1', text: '收敛', tags: ['convergence'] }] }],
  },
  {
    id: 'T24',
    pos: [{}, {}, { budgetState: { phase: 'exhausted' } }],
    neg: [{}, {}, { budgetState: { phase: 'explore' } }],
  },
];

test('traps：受控词表 24 条且字段完整', () => {
  assert.equal(TRAPS.length, 24);
  assert.deepEqual(TRAPS.map((trap) => trap.id), Array.from({ length: 24 }, (_, index) => `T${String(index + 1).padStart(2, '0')}`));
  for (const trap of TRAPS) {
    assert.equal(typeof trap.name, 'string');
    assert.ok(['minor', 'major', 'blocker'].includes(trap.severity));
    assert.equal(typeof trap.defaultDeduct, 'number');
    assert.ok(['rule', 'heuristic'].includes(trap.basis));
    assert.equal(typeof trap.detect, 'function');
    assert.equal(trapById(trap.id).id, trap.id);
  }
  assert.equal(trapById('T11').basis, 'heuristic');
  assert.equal(trapById('T24').defaultDeduct, 0);
});

for (const item of cases) {
  test(`traps：${item.id} 正反例`, () => {
    const pos = build(item.pos[0], item.pos[1]);
    const posCtx = item.pos[2] ?? {};
    assert.ok(idsFor(pos, posCtx).has(item.id), `${item.id} 正例未命中`);
    const neg = build(item.neg[0], item.neg[1]);
    const negCtx = item.neg[2] ?? {};
    assert.equal(idsFor(neg, negCtx).has(item.id), false, `${item.id} 反例误命中`);
  });
}

test('traps：deduction_rules 覆盖默认扣分，heuristic 不扣分', () => {
  const { contract, solution } = build(
    { grading_rubric: { ...makeContract().grading_rubric, deduction_rules: [{ trap: 'T01', deduct: 5 }] } },
    { steps: [{ id: 'S1', text: 'x', tags: [] }] },
  );
  const findings = detectTraps({ contract, solution });
  const t01 = findings.find((finding) => finding.trap === 'T01');
  assert.equal(t01.deduct, 5);
  const t11 = findings.find((finding) => finding.trap === 'T11');
  assert.equal(t11, undefined);
});

test('traps：finding 形状与排序固定', () => {
  const { contract, solution } = build({}, { steps: [] });
  const findings = detectTraps({ contract, solution });
  for (const finding of findings) {
    assert.equal(typeof finding.trap, 'string');
    assert.ok(['minor', 'major', 'blocker'].includes(finding.severity));
    assert.ok(['rule', 'heuristic'].includes(finding.basis));
    assert.equal(typeof finding.deduct, 'number');
    assert.equal(typeof finding.detail, 'string');
  }
  const sorted = [...findings].map((finding) => finding.trap);
  assert.deepEqual(sorted, [...sorted].sort());
});

test('traps：T02 已知条件含绝对值 / 中文「绝对值」也触发', () => {
  const viaGiven = build({ givens: [{ id: 'G1', text: '已知 |a|=2', required: true }] }, {});
  assert.ok(idsFor(viaGiven).has('T02'));
  const viaChinese = build({ problem: { text: '解绝对值方程' } }, {});
  assert.ok(idsFor(viaChinese).has('T02'));
  const negative = build({ problem: { text: '解绝对值方程' } }, { steps: [{ id: 'S1', text: 'x', tags: ['cases:2'] }] });
  assert.equal(idsFor(negative).has('T02'), false);
});

test('traps：T03 含 lg 也触发', () => {
  const positive = build({ problem: { text: '求 lg(x) 的定义域' } }, {});
  assert.ok(idsFor(positive).has('T03'));
  const negative = build({ problem: { text: '求 lg(x) 的定义域' } }, { steps: [{ id: 'S1', text: 'x>0', tags: ['domain'] }] });
  assert.equal(idsFor(negative).has('T03'), false);
});

test('traps：T07 支持分号与「或」切分', () => {
  const contract = { verification: { expected_solution_count: 3 } };
  assert.ok(idsFor(build(contract, { answer: { value: '1;2' } })).has('T07'));
  assert.ok(idsFor(build(contract, { answer: { value: '1 或 2' } })).has('T07'));
  assert.ok(idsFor(build(contract, { answer: { value: '1；2' } })).has('T07'));
  assert.equal(idsFor(build(contract, { answer: { value: '1;2;3' } })).has('T07'), false);
});

test('traps：T08 单字符参数名集合即可触发', () => {
  for (const symbol of ['a', 'b', 'c', 'k', 'm', 'n', 'p', 't', 'λ', 'θ']) {
    const positive = build({ givens: [{ id: 'G1', text: '条件', symbol, required: true }] }, {});
    assert.ok(idsFor(positive).has('T08'), symbol);
  }
  const negative = build({ givens: [{ id: 'G1', text: '条件', symbol: 'a', required: true }] }, { steps: [{ id: 'S1', text: '讨论', tags: ['param-range'] }] });
  assert.equal(idsFor(negative).has('T08'), false);
  const notParameter = build({ givens: [{ id: 'G1', text: 'f(x)', symbol: 'f', required: true }] }, {});
  assert.equal(idsFor(notParameter).has('T08'), false);
});

test('traps：T09 兼容单数 endpoint 字段', () => {
  const positive = build({
    answer_format: { type: 'interval', endpoint: { left: 'open', right: 'open' } },
  }, { answer: { value: '[0,2]' } });
  assert.ok(idsFor(positive).has('T09'));
  const negative = build({
    answer_format: { type: 'interval', endpoint: { left: 'open', right: 'open' } },
  }, { answer: { value: '(0,2)' } });
  assert.equal(idsFor(negative).has('T09'), false);
});

test('traps：T15 含希腊字母', () => {
  const positive = build({ problem: { text: '已知 x=1' } }, { steps: [{ id: 'S1', text: '设 t=x^2，则 t+ξ' }] });
  assert.ok(idsFor(positive).has('T15'));
  const negative = build({ problem: { text: '已知 x=1，ξ∈R' } }, { steps: [{ id: 'S1', text: '设 t=x^2，则 t+ξ' }] });
  assert.equal(idsFor(negative).has('T15'), false);
  const defined = build({ problem: { text: '已知 x=1' } }, { steps: [{ id: 'S1', text: '令 ξ=x^2，则 ξ+1' }] });
  assert.equal(idsFor(defined).has('T15'), false);
});

test('traps：T20 跨 step 的 AB/BA 不触发', () => {
  const crossStep = build({ domain: 'linear_algebra' }, {
    steps: [{ id: 'S1', text: 'AB=C' }, { id: 'S2', text: 'BA=D' }],
  });
  assert.equal(idsFor(crossStep).has('T20'), false);
  const sameStep = build({ domain: 'linear_algebra' }, { steps: [{ id: 'S1', text: 'AB=BA' }] });
  assert.ok(idsFor(sameStep).has('T20'));
});

test('traps：T19/T23 不再仅凭 domain 触发', () => {
  assert.equal(idsFor(build({ domain: 'probability' }, {})).has('T19'), false);
  assert.equal(idsFor(build({ domain: 'series' }, {})).has('T23'), false);
  assert.ok(idsFor(build({ problem: { text: '已知事件 A、B 满足 P(AB)=P(A)P(B)' } }, {})).has('T19'));
  assert.ok(idsFor(build({ domain: 'series', problem: { text: '判断该级数是否收敛' } }, {})).has('T23'));
});
