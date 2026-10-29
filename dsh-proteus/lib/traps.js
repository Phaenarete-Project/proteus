/**
 * 陷阱库：把中国数学应试里的高频扣分点写成可执行规则。
 *
 * 24 个 ID 与 spec §6.1、技能库 `陷阱库.md` 必须一致。
 * `basis="rule"` 才允许扣分；`heuristic` 只提示（T11）。
 * detect 的公开签名是 `detect(solution, contract, ctx?)`；locate 只是内部实现，
 * 用来附带 step/detail。
 */

import { FUNCTION_NAMES } from './expr.js';

const FUNCTION_SET = new Set(FUNCTION_NAMES);
const SINGLE_CONSTANT = new Set(['e', 'i']);

function stepsOf(solution) {
  return Array.isArray(solution?.steps) ? solution.steps.filter((step) => step && typeof step === 'object') : [];
}

function stepText(step) {
  return typeof step?.text === 'string' ? step.text : '';
}

function allText(solution, contract) {
  return [typeof contract?.problem?.text === 'string' ? contract.problem.text : '', ...stepsOf(solution).map(stepText)].join('\n');
}

function tagsOf(solution) {
  const tags = [];
  for (const step of stepsOf(solution)) {
    if (Array.isArray(step.tags)) for (const tag of step.tags) tags.push(String(tag));
  }
  return tags;
}

function hasTag(solution, tag) {
  return tagsOf(solution).includes(tag);
}

function stepHasTag(step, tag) {
  return Array.isArray(step?.tags) && step.tags.map(String).includes(tag);
}

function problemText(contract) {
  return typeof contract?.problem?.text === 'string' ? contract.problem.text : '';
}

function givensOf(contract) {
  return Array.isArray(contract?.givens) ? contract.givens.filter((given) => given && typeof given === 'object') : [];
}

function maxCasesCount(solution) {
  let max = 0;
  for (const tag of tagsOf(solution)) {
    const match = /^cases:(\d+)$/.exec(tag);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function answerText(solution) {
  const value = solution?.answer?.value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function countSolutions(value) {
  if (Array.isArray(value)) return value.length;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return 0;
  // 区间 [a,b] / (a,b) 视为一个解；集合 {a,b} 与逗号列表按元素计数。
  if (/^[[(].*[\])]$/.test(text)) return 1;
  const inner = text.replace(/^\{/, '').replace(/\}$/, '');
  return inner.split(/[,;；]|或/).map((item) => item.trim()).filter(Boolean).length;
}

function hasSlashDenominator(text) {
  return /\/\s*\(?\s*[A-Za-z]/.test(text) || /\\frac\s*\{[^{}]*\}\s*\{[^{}]*[A-Za-z]/.test(text);
}

const PARAMETER_SYMBOLS = new Set(['a', 'b', 'c', 'k', 'm', 'n', 'p', 't', 'λ', 'θ']);

function isParameterSymbol(given) {
  if (!given || typeof given.symbol !== 'string') return false;
  const symbol = given.symbol.trim();
  if (symbol.length !== 1) return false;
  return PARAMETER_SYMBOLS.has(symbol) || PARAMETER_SYMBOLS.has(symbol.toLowerCase());
}

function normalizeEndpoint(value) {
  const text = String(value ?? '').toLowerCase();
  if (text === 'open' || text === '(' || text === ')') return 'open';
  if (text === 'closed' || text === '[' || text === ']') return 'closed';
  return null;
}

/** 内部规则：返回 null（未命中）或 {step?, detail}。 */
const DEFINITIONS = [
  {
    id: 'T01',
    name: '定义域遗漏',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      if (!['calculus', 'geometry'].includes(contract?.domain)) return null;
      if (hasTag(solution, 'domain')) return null;
      return { detail: `${contract.domain} 题未声明定义域（缺 domain tag）` };
    },
  },
  {
    id: 'T02',
    name: '绝对值分类讨论不全',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      const text = [problemText(contract), ...givensOf(contract).map((given) => given.text ?? '')].join('\n');
      if (!/[|｜]/.test(text) && !text.includes('绝对值')) return null;
      if (maxCasesCount(solution) >= 2) return null;
      return { detail: '题面/已知含绝对值，分类数不足 2（缺 cases:N tag）' };
    },
  },
  {
    id: 'T03',
    name: '对数定义域遗漏',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      if (!/\b(?:log|lg|ln)\b/i.test(allText(solution, contract))) return null;
      if (hasTag(solution, 'domain')) return null;
      return { detail: '含对数运算但未声明真数 > 0（缺 domain tag）' };
    },
  },
  {
    id: 'T04',
    name: '偶次根号定义域遗漏',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      if (!/sqrt|√|\\sqrt/i.test(allText(solution, contract))) return null;
      if (hasTag(solution, 'domain')) return null;
      return { detail: '含根号但未声明被开方数非负（缺 domain tag）' };
    },
  },
  {
    id: 'T05',
    name: '分母为零未排除',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      if (!hasSlashDenominator(allText(solution, contract))) return null;
      if (hasTag(solution, 'domain')) return null;
      return { detail: '含变量分母但未排除分母为零（缺 domain tag）' };
    },
  },
  {
    id: 'T06',
    name: '单位遗漏',
    severity: 'minor',
    defaultDeduct: 1,
    basis: 'rule',
    locate(solution, contract) {
      const units = contract?.answer_format?.units;
      if (typeof units !== 'string' || units.trim() === '') return null;
      const unit = solution?.answer?.unit;
      if (typeof unit === 'string' && unit.trim() !== '') return null;
      return { detail: `契约要求单位 ${units}，答案未带单位` };
    },
  },
  {
    id: 'T07',
    name: '多解遗漏',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      const expected = contract?.verification?.expected_solution_count;
      if (!Number.isFinite(expected)) return null;
      const actual = countSolutions(solution?.answer?.value);
      if (actual >= expected) return null;
      return { detail: `预期 ${expected} 个解，答案给出 ${actual} 个` };
    },
  },
  {
    id: 'T08',
    name: '参数范围未讨论',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      const parameters = givensOf(contract).filter((given) => isParameterSymbol(given));
      if (parameters.length === 0) return null;
      if (hasTag(solution, 'param-range')) return null;
      return { detail: `含参数 ${parameters.map((given) => given.symbol).join(',')} 但未讨论参数范围（缺 param-range tag）` };
    },
  },
  {
    id: 'T09',
    name: '区间端点开闭错误',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      if (contract?.answer_format?.type !== 'interval') return null;
      const expected = contract?.answer_format?.endpoints ?? contract?.answer_format?.endpoint;
      if (!expected || typeof expected !== 'object') return null;
      const text = answerText(solution);
      const match = /^([[(])(.*),([^,]*)([\])])$/.exec(text);
      if (!match) return null;
      const expectedLeft = normalizeEndpoint(expected.left);
      const expectedRight = normalizeEndpoint(expected.right);
      const actualLeft = normalizeEndpoint(match[1]);
      const actualRight = normalizeEndpoint(match[4]);
      if (expectedLeft === null && expectedRight === null) return null;
      if (expectedLeft !== null && expectedLeft !== actualLeft) {
        return { detail: `区间左端点应为 ${expectedLeft}，实际为 ${actualLeft}` };
      }
      if (expectedRight !== null && expectedRight !== actualRight) {
        return { detail: `区间右端点应为 ${expectedRight}，实际为 ${actualRight}` };
      }
      return null;
    },
  },
  {
    id: 'T10',
    name: '充分必要混淆',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      if (contract?.goal?.kind !== 'prove') return null;
      if (!hasTag(solution, 'iff')) return null;
      const forward = hasTag(solution, 'forward');
      const backward = hasTag(solution, 'backward');
      if (forward && backward) return null;
      return { detail: '使用了充要（iff）却只证明了一个方向（缺 forward/backward tag）' };
    },
  },
  {
    id: 'T11',
    name: '循环论证',
    severity: 'blocker',
    defaultDeduct: 0,
    basis: 'heuristic',
    locate(solution, contract) {
      const statement = typeof contract?.goal?.statement === 'string' ? contract.goal.statement.trim() : '';
      if (contract?.goal?.kind !== 'prove' || statement.length < 6) return null;
      for (const step of stepsOf(solution)) {
        const text = stepText(step);
        if (!text.includes(statement)) continue;
        const refs = Array.isArray(step.evidence_refs) ? step.evidence_refs : [];
        const independent = refs.length > 0 || (Array.isArray(step.tags) && step.tags.some((tag) => String(tag).startsWith('theorem:')));
        if (!independent) {
          return { step: step.id, detail: '结论被直接用作依据且无独立证据（heuristic，不扣分）' };
        }
      }
      return null;
    },
  },
  {
    id: 'T12',
    name: '增根未检验',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution) {
      if (!hasTag(solution, 'square-both-sides')) return null;
      if (hasTag(solution, 'check:extraneous')) return null;
      return { detail: '两边平方后未检验增根（缺 check:extraneous tag）' };
    },
  },
  {
    id: 'T13',
    name: '过早四舍五入',
    severity: 'minor',
    defaultDeduct: 1,
    basis: 'rule',
    locate(solution, contract) {
      const tolerance = contract?.answer_format?.tolerance;
      const abs = Number.isFinite(tolerance?.abs) ? tolerance.abs : Number.isFinite(tolerance?.rel) ? tolerance.rel : null;
      if (!abs || abs <= 0) return null;
      const text = answerText(solution);
      const match = /^[+-]?\d+\.(\d+)$/.exec(text);
      if (!match) return null;
      const needed = Math.max(1, Math.ceil(-Math.log10(abs)));
      if (match[1].length >= needed) return null;
      const steps = stepsOf(solution);
      const hasApprox = steps.slice(0, Math.max(0, steps.length - 1)).some((step) => stepText(step).includes('≈'));
      if (!hasApprox) return null;
      return { detail: `中间步骤含 ≈，最终答案仅 ${match[1].length} 位小数（容差要求 ${needed} 位）` };
    },
  },
  {
    id: 'T14',
    name: '无结论句',
    severity: 'minor',
    defaultDeduct: 1,
    basis: 'rule',
    locate(solution, contract) {
      if (contract?.goal?.kind !== 'prove') return null;
      if (hasTag(solution, 'conclusion')) return null;
      return { detail: '证明题缺少结论句（缺 conclusion tag）' };
    },
  },
  {
    id: 'T15',
    name: '符号未定义',
    severity: 'minor',
    defaultDeduct: 1,
    basis: 'rule',
    locate(solution, contract) {
      const greekConstant = new Set(['π']);
      const allowed = new Set(greekConstant);
      const rawSeedText = `${problemText(contract)}\n${givensOf(contract).map((given) => given.text ?? '').join('\n')}`;
      // 数集符号 R/N/Z/Q/C 与定义域 D 视为已定义。
      for (const match of rawSeedText.matchAll(/\b[RNZQCD]\b/g)) allowed.add(match[0].toLowerCase());
      for (const match of rawSeedText.toLowerCase().matchAll(/\b[a-z]\b/g)) allowed.add(match[0]);
      for (const match of rawSeedText.matchAll(/[\u03b1-\u03c9]/g)) allowed.add(match[0]);
      for (const given of givensOf(contract)) {
        if (typeof given.symbol !== 'string') continue;
        for (const char of given.symbol) {
          if (/[a-zA-Z]/.test(char)) allowed.add(char.toLowerCase());
          else if (/[\u03b1-\u03c9]/.test(char)) allowed.add(char);
        }
      }

      const latinIn = (text) => [...text.toLowerCase().matchAll(/\b[a-z]\b/g)].map((match) => match[0]);
      const greekIn = (text) => [...text.matchAll(/[\u03b1-\u03c9]/g)].map((match) => match[0]);

      for (const step of stepsOf(solution)) {
        const rawText = stepText(step);
        for (const match of rawText.matchAll(/\b[RNZQCD]\b/g)) allowed.add(match[0].toLowerCase());
        const text = rawText.toLowerCase();
        const definedHere = new Set();
        for (const match of text.matchAll(/(?:设|令|记)\s*([a-z])\s*(?:[=＝,，]|[^a-z])/g)) definedHere.add(match[1]);
        for (const match of text.matchAll(/\b([a-z])\s*[=＝]/g)) definedHere.add(match[1]);
        for (const match of rawText.matchAll(/(?:设|令|记)\s*([\u03b1-\u03c9])\s*(?:[=＝,，]|[^\u03b1-\u03c9])/g)) definedHere.add(match[1]);
        for (const match of rawText.matchAll(/([\u03b1-\u03c9])\s*[=＝]/g)) definedHere.add(match[1]);

        for (const symbol of [...latinIn(rawText), ...greekIn(rawText)]) {
          if (allowed.has(symbol) || definedHere.has(symbol)) continue;
          if (FUNCTION_SET.has(symbol) || SINGLE_CONSTANT.has(symbol)) continue;
          return { step: step.id, detail: `步骤 ${step.id || '(无 id)'} 使用了未定义符号 "${symbol}"` };
        }
        for (const symbol of [...latinIn(rawText), ...greekIn(rawText)]) allowed.add(symbol);
      }
      return null;
    },
  },
  {
    id: 'T16',
    name: '选择题干扰项',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      const distractors = Array.isArray(contract?.distractors)
        ? contract.distractors
        : Array.isArray(contract?.answer_format?.distractors)
          ? contract.answer_format.distractors
          : [];
      if (distractors.length === 0) return null;
      const answer = answerText(solution);
      const hit = distractors.some((item) => String(item).trim() === answer);
      if (!hit) return null;
      return { detail: `答案命中干扰项 "${answer}"` };
    },
  },
  {
    id: 'T17',
    name: '条件未用尽',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      const tags = tagsOf(solution);
      const required = givensOf(contract).filter((given) => given.required === true);
      for (const given of required) {
        if (!tags.includes(`uses:${given.id}`)) {
          return { detail: `已知条件 ${given.id} 未在步骤中引用（缺 uses:${given.id} tag）` };
        }
      }
      return null;
    },
  },
  {
    id: 'T18',
    name: '计数重复/遗漏',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      const text = problemText(contract);
      const isCounting = contract?.domain === 'probability' || /排列|组合|计数|种数|多少种/.test(text);
      if (!isCounting) return null;
      if (tagsOf(solution).some((tag) => /^cases:\d+$/.test(tag))) return null;
      return { detail: '计数/概率题未枚举情形（缺 cases:N tag）' };
    },
  },
  {
    id: 'T19',
    name: '独立性误用',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      const text = [problemText(contract), ...givensOf(contract).map((given) => given.text ?? '')].join('\n');
      if (!/独立|条件概率|P\s*\(\s*A\s*B\s*\)/i.test(text)) return null;
      if (hasTag(solution, 'independent')) return null;
      return { detail: '题面/已知涉及独立性或条件概率，未声明独立性假设（缺 independent tag）' };
    },
  },
  {
    id: 'T20',
    name: '矩阵乘法顺序错误',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      if (contract?.domain !== 'linear_algebra') return null;
      for (const step of stepsOf(solution)) {
        const text = stepText(step);
        if (/\bAB\b/.test(text) && /\bBA\b/.test(text)) {
          return { step: step.id, detail: '同一 step 中 AB 与 BA 混用，需检查矩阵乘法顺序' };
        }
      }
      return null;
    },
  },
  {
    id: 'T21',
    name: '行列式符号错误',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract, ctx) {
      if (contract?.domain !== 'linear_algebra') return null;
      const evidence = Array.isArray(ctx?.evidence) ? ctx.evidence : [];
      const failed = evidence.some((item) => item && item.kind === 'numeric' && item.status === 'fail');
      if (!failed) return null;
      return { detail: '线性代数题数值回代失败，检查行列式符号' };
    },
  },
  {
    id: 'T22',
    name: '秩判断错误',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      if (contract?.domain !== 'linear_algebra') return null;
      if (hasTag(solution, 'rank')) return null;
      return { detail: '线性代数题未声明秩的判断（缺 rank tag）' };
    },
  },
  {
    id: 'T23',
    name: '收敛性未检验',
    severity: 'major',
    defaultDeduct: 2,
    basis: 'rule',
    locate(solution, contract) {
      const text = [problemText(contract), ...stepsOf(solution).map(stepText)].join('\n');
      if (!/级数|收敛|发散/.test(text)) return null;
      if (hasTag(solution, 'convergence')) return null;
      return { detail: '题面/步骤涉及级数收敛性，未检验（缺 convergence tag）' };
    },
  },
  {
    id: 'T24',
    name: '时间超限',
    severity: 'minor',
    defaultDeduct: 0,
    basis: 'rule',
    locate(_solution, _contract, ctx) {
      if (ctx?.budgetState?.phase !== 'exhausted') return null;
      return { detail: '时间预算耗尽，只输出已有证据的最佳答案' };
    },
  },
];

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

/**
 * 对外受控词表。元素形状与 spec §6.1 一致：
 * `{id,name,severity,defaultDeduct,basis,detect(solution,contract,ctx?)}`。
 */
export const TRAPS = DEFINITIONS.map((definition) => {
  const { locate, ...meta } = definition;
  return {
    ...meta,
    detect(solution, contract, ctx) {
      try {
        return locate(solution, contract, ctx) !== null;
      } catch {
        return false;
      }
    },
  };
});

/** 按 ID 取陷阱元数据（只读）。 */
export function trapById(id) {
  return TRAPS.find((trap) => trap.id === id) ?? null;
}

function deductionFor(trap, contract) {
  const rules = Array.isArray(contract?.grading_rubric?.deduction_rules)
    ? contract.grading_rubric.deduction_rules
    : [];
  const rule = rules.find((item) => item && item.trap === trap.id && Number.isFinite(item.deduct));
  return rule ? rule.deduct : trap.defaultDeduct;
}

/**
 * 检测全部陷阱。
 * @param {{contract: object, solution: object, evidence?: object[], budgetState?: object}} input
 * @returns {object[]} TrapFinding[]
 */
export function detectTraps({ contract, solution, evidence, budgetState } = {}) {
  const findings = [];
  const ctx = { evidence, budgetState };
  for (const definition of DEFINITIONS) {
    let hit = null;
    try {
      hit = definition.locate(solution ?? {}, contract ?? {}, ctx);
    } catch {
      hit = null;
    }
    if (!hit) continue;
    const meta = BY_ID.get(definition.id);
    const finding = {
      trap: meta.id,
      severity: meta.severity,
      basis: meta.basis,
      deduct: Math.max(0, deductionFor(meta, contract)),
      detail: hit.detail ?? meta.name,
    };
    if (hit.step !== undefined) finding.step = hit.step;
    findings.push(finding);
  }
  findings.sort((a, b) => (a.trap < b.trap ? -1 : a.trap > b.trap ? 1 : 0));
  return findings;
}
