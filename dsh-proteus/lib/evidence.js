/**
 * 多路验证：计划（plan）、执行（runChecks）、证据摘要（summarize）。
 *
 * v0.1 只有 JS 数值回代，没有符号引擎/形式化证明适配器，因此：
 * - `numeric_residual`  kind=numeric   （回代方程算残差）
 * - `expression_sample`kind=numeric   （采样比较参考表达式与答案；数值介质，不是 CAS）
 * - `domain_probe`     kind=numeric   （参考表达式有定义的采样点上答案也必须有定义）
 * - `answer_format`    kind=structural（不计入独立证据种类）
 *
 * 无法验证时保留 `unknown`，绝不静默当作 pass。
 */

import { digest, sha256Hex } from './canonical.js';
import { evalNumeric, parseEquation, sameValue, toFiniteNumber } from './expr.js';
import { EVIDENCE_KINDS } from './contract.js';

export const CHECK_IDS = ['answer_format', 'numeric_residual', 'expression_sample', 'domain_probe'];

const CHECK_META = {
  answer_format: { kind: 'structural', description: '答案格式、端点与单位符合契约' },
  numeric_residual: { kind: 'numeric', description: '把答案回代契约方程，计算数值残差' },
  expression_sample: { kind: 'numeric', description: '采样比较答案表达式与参考表达式（数值介质，不是 CAS）' },
  domain_probe: { kind: 'numeric', description: '在参考表达式有定义的采样点上探测答案定义域' },
};

const DEFAULT_TOLERANCE = { abs: 1e-6, rel: 1e-6 };
const SAMPLE_COUNT = 8;
const PROBE_COUNT = 12;

/** 确定性 PRNG（mulberry32）。 */
function mulberry32(seed) {
  let a = Math.trunc(Number(seed) || 0) >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const rounded = Number(value.toPrecision(6));
  return String(rounded);
}

function describeEnv(env) {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return '∅';
  return entries.map(([key, value]) => `${key}=${formatNumber(value)}`).join(',');
}

function toRange(raw, fallback) {
  if (Array.isArray(raw) && raw.length === 2 && raw.every((item) => Number.isFinite(item))) {
    return [raw[0], raw[1]];
  }
  return fallback;
}

function makeEnvironments(variables, rangeRaw, seed, count) {
  const range = toRange(rangeRaw, [-10, 10]);
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  const span = hi - lo;
  if (!Array.isArray(variables) || variables.length === 0) return [{}];
  const random = mulberry32(seed);
  const envs = [];
  for (let index = 0; index < count; index += 1) {
    const env = {};
    for (const variable of variables) {
      const fraction = span === 0 ? 0 : (index + random()) / count;
      env[variable] = lo + span * fraction;
    }
    envs.push(env);
  }
  return envs;
}

function evaluate(expression, env) {
  try {
    const value = evalNumeric(expression, env);
    if (!Number.isFinite(value)) return { ok: false, reason: 'NON_FINITE' };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, reason: error?.name ? `${error.name}:${error.message}` : String(error) };
  }
}

/** 答案的表达式形式；纯数字/可解析数字返回数字字符串，区间/集合/证明返回 null。 */
function answerExpression(contract, solution) {
  const value = solution?.answer?.value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    const numeric = toFiniteNumber(text);
    if (numeric !== null) return String(numeric);
    if (contract?.answer_format?.type === 'interval' || contract?.answer_format?.type === 'set') return null;
    return text;
  }
  return null;
}

function toleranceOf(contract, fallback = DEFAULT_TOLERANCE) {
  const tolerance = contract?.answer_format?.tolerance;
  if (tolerance && (Number.isFinite(tolerance.abs) || Number.isFinite(tolerance.rel))) return tolerance;
  return fallback;
}

/**
 * 答案格式检查（供 rubric 复用；不产生证据）。
 * @returns {{status: 'pass'|'fail', detail: string}}
 */
export function checkAnswerFormat(contract, solution) {
  const value = solution?.answer?.value;
  const type = contract?.answer_format?.type ?? 'exact';
  const empty = value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
  if (empty) return { status: 'fail', detail: 'NO_ANSWER' };

  const expectedUnit = typeof contract?.answer_format?.units === 'string' ? contract.answer_format.units.trim() : '';
  const actualUnit = typeof solution?.answer?.unit === 'string' ? solution.answer.unit.trim() : '';
  if (expectedUnit !== '') {
    if (actualUnit === '') return { status: 'fail', detail: `UNITS_MISSING:${expectedUnit}` };
    if (actualUnit !== expectedUnit) return { status: 'fail', detail: `UNIT_MISMATCH:${actualUnit}!=${expectedUnit}` };
  }

  switch (type) {
    case 'numerical': {
      const numeric = typeof value === 'number' ? value : toFiniteNumber(value);
      if (numeric === null) return { status: 'fail', detail: 'NOT_NUMERIC' };
      return { status: 'pass', detail: `numeric=${formatNumber(numeric)}` };
    }
    case 'interval': {
      const text = String(value).trim();
      const match = /^([[(])(.*),([^,]*)([\])])$/.exec(text);
      if (!match) return { status: 'fail', detail: 'NOT_INTERVAL' };
      const endpoints = contract?.answer_format?.endpoints ?? contract?.answer_format?.endpoint;
      if (endpoints && typeof endpoints === 'object') {
        const normalize = (item) => {
          const raw = String(item ?? '').toLowerCase();
          if (raw === 'open' || raw === '(' || raw === ')') return 'open';
          if (raw === 'closed' || raw === '[' || raw === ']') return 'closed';
          return null;
        };
        const expectedLeft = normalize(endpoints.left);
        const expectedRight = normalize(endpoints.right);
        const actualLeft = match[1] === '(' ? 'open' : 'closed';
        const actualRight = match[4] === ')' ? 'open' : 'closed';
        if (expectedLeft !== null && expectedLeft !== actualLeft) return { status: 'fail', detail: 'ENDPOINT_MISMATCH_LEFT' };
        if (expectedRight !== null && expectedRight !== actualRight) return { status: 'fail', detail: 'ENDPOINT_MISMATCH_RIGHT' };
      }
      return { status: 'pass', detail: 'interval' };
    }
    case 'set': {
      const text = String(value).trim();
      if (Array.isArray(value)) return { status: 'pass', detail: `set:${value.length}` };
      if (!/^\{.*\}$/.test(text)) return { status: 'fail', detail: 'NOT_SET' };
      return { status: 'pass', detail: 'set' };
    }
    case 'expression': {
      const text = String(value).trim();
      if (text === '') return { status: 'fail', detail: 'EMPTY_EXPRESSION' };
      let balance = 0;
      for (const char of text) {
        if (char === '(') balance += 1;
        else if (char === ')') balance -= 1;
        if (balance < 0) return { status: 'fail', detail: 'UNBALANCED_PARENS' };
      }
      if (balance !== 0) return { status: 'fail', detail: 'UNBALANCED_PARENS' };
      return { status: 'pass', detail: 'expression' };
    }
    case 'proof': {
      const text = String(value).trim();
      if (text.length < 2) return { status: 'fail', detail: 'PROOF_TOO_SHORT' };
      return { status: 'pass', detail: 'proof' };
    }
    case 'exact':
    default: {
      if (typeof value === 'number') return { status: 'pass', detail: `number=${formatNumber(value)}` };
      const text = String(value).trim();
      if (text === '') return { status: 'fail', detail: 'EMPTY_ANSWER' };
      return { status: 'pass', detail: 'exact' };
    }
  }
}

/**
 * 生成检查计划。
 * @param {object} contract
 * @returns {object[]} Check[]
 */
export function buildPlan(contract) {
  const verification = contract?.verification ?? null;
  const requested = Array.isArray(verification?.checks) && verification.checks.length > 0
    ? new Set(verification.checks)
    : null;
  const ids = requested ? CHECK_IDS.filter((id) => requested.has(id)) : CHECK_IDS.slice();
  return ids.map((id) => {
    const meta = CHECK_META[id];
    const check = { id, kind: meta.kind, description: meta.description, available: true, reason: null };
    if (verification === null) {
      if (id === 'answer_format') return check;
      check.available = false;
      check.reason = 'NO_VERIFICATION';
      return check;
    }
    if (id === 'numeric_residual') {
      if (!Array.isArray(verification.equations) || verification.equations.length === 0) {
        check.available = false;
        check.reason = 'NO_EQUATIONS';
      }
    } else if (id === 'expression_sample') {
      if (typeof verification.reference_expr !== 'string' || verification.reference_expr.trim() === '') {
        check.available = false;
        check.reason = 'NO_REFERENCE_EXPR';
      }
    } else if (id === 'domain_probe') {
      const hasReference = typeof verification.reference_expr === 'string' && verification.reference_expr.trim() !== '';
      const hasEquations = Array.isArray(verification.equations) && verification.equations.length > 0;
      if (!hasReference && !hasEquations) {
        check.available = false;
        check.reason = 'NO_EXPRESSION';
      }
    }
    return check;
  });
}

function runAnswerFormat(contract, solution) {
  const result = checkAnswerFormat(contract, solution);
  return { status: result.status === 'pass' ? 'pass' : 'fail', detail: result.detail };
}

function runNumericResidual(contract, solution) {
  const verification = contract?.verification ?? {};
  const equations = Array.isArray(verification.equations) ? verification.equations : [];
  const variables = Array.isArray(verification.variables) ? verification.variables : [];
  const tolerance = Number.isFinite(contract?.answer_format?.tolerance?.abs)
    ? Math.abs(contract.answer_format.tolerance.abs)
    : 1e-6;

  if (variables.length > 1) return { status: 'unknown', detail: 'MULTIVARIABLE_UNSUPPORTED' };

  const env = {};
  if (variables.length === 1) {
    const raw = solution?.answer?.value;
    const numeric = typeof raw === 'number' ? raw : toFiniteNumber(raw);
    if (numeric === null) return { status: 'unknown', detail: 'ANSWER_NOT_NUMERIC' };
    env[variables[0]] = numeric;
  }

  let worst = 0;
  for (const equation of equations) {
    let parsed;
    try {
      parsed = parseEquation(equation);
    } catch {
      return { status: 'unknown', detail: `EQUATION_UNPARSEABLE:${equation}` };
    }
    let lhs;
    let rhs;
    try {
      lhs = evalNumeric(parsed.lhs, env);
      rhs = evalNumeric(parsed.rhs, env);
    } catch (error) {
      return { status: 'unknown', detail: `EVAL_FAILED:${equation}:${error?.message ?? error}` };
    }
    if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) {
      return { status: 'unknown', detail: `NON_FINITE:${equation}` };
    }
    const residual = Math.abs(lhs - rhs);
    worst = Math.max(worst, residual);
    if (residual > tolerance) {
      return {
        status: 'fail',
        detail: `residual=${formatNumber(residual)}>${formatNumber(tolerance)} @ ${describeEnv(env)}`,
      };
    }
  }
  return { status: 'pass', detail: `residual_max=${formatNumber(worst)} @ ${describeEnv(env)}` };
}

function runExpressionSample(contract, solution, seed) {
  const verification = contract?.verification ?? {};
  const reference = verification.reference_expr;
  if (typeof reference !== 'string' || reference.trim() === '') {
    return { status: 'unknown', detail: 'NO_REFERENCE_EXPR' };
  }
  const candidate = answerExpression(contract, solution);
  if (candidate === null) return { status: 'unknown', detail: 'ANSWER_NOT_EXPRESSION' };
  const variables = Array.isArray(verification.variables) ? verification.variables : [];
  const envs = makeEnvironments(variables, verification.sample_range, seed, variables.length === 0 ? 1 : SAMPLE_COUNT);
  const tolerance = toleranceOf(contract);
  let compared = 0;
  for (const env of envs) {
    const referenceValue = evaluate(reference, env);
    if (!referenceValue.ok) continue; // 参考表达式在采样点无定义：跳过
    const answerValue = evaluate(candidate, env);
    if (!answerValue.ok) {
      return { status: 'fail', detail: `ANSWER_UNDEFINED @ ${describeEnv(env)}` };
    }
    compared += 1;
    if (!sameValue(referenceValue.value, answerValue.value, tolerance)) {
      return {
        status: 'fail',
        detail: `mismatch @ ${describeEnv(env)}: ref=${formatNumber(referenceValue.value)} answer=${formatNumber(answerValue.value)}`,
      };
    }
  }
  if (compared === 0) return { status: 'unknown', detail: 'NO_FINITE_SAMPLES' };
  return { status: 'pass', detail: `compared=${compared} samples` };
}

function runDomainProbe(contract, solution, seed) {
  const verification = contract?.verification ?? {};
  const reference = typeof verification.reference_expr === 'string' && verification.reference_expr.trim() !== ''
    ? verification.reference_expr
    : null;
  let probeExpression = reference;
  if (probeExpression === null) {
    const first = Array.isArray(verification.equations) ? verification.equations[0] : null;
    if (typeof first !== 'string') return { status: 'unknown', detail: 'NO_EXPRESSION' };
    try {
      const parsed = parseEquation(first);
      probeExpression = `(${parsed.lhs})-(${parsed.rhs})`;
    } catch {
      return { status: 'unknown', detail: 'EQUATION_UNPARSEABLE' };
    }
  }
  const candidate = answerExpression(contract, solution);
  if (candidate === null) return { status: 'unknown', detail: 'ANSWER_NOT_EXPRESSION' };
  const variables = Array.isArray(verification.variables) ? verification.variables : [];
  const envs = makeEnvironments(variables, verification.sample_range, seed, PROBE_COUNT);
  let probed = 0;
  for (const env of envs) {
    const referenceValue = evaluate(probeExpression, env);
    if (!referenceValue.ok) continue; // 参考表达式本身无定义，不构成探测点
    probed += 1;
    const answerValue = evaluate(candidate, env);
    if (!answerValue.ok) {
      return { status: 'fail', detail: `ANSWER_UNDEFINED @ ${describeEnv(env)}` };
    }
  }
  if (probed === 0) return { status: 'unknown', detail: 'NO_FINITE_SAMPLES' };
  return { status: 'pass', detail: `probed=${probed} samples` };
}

function executeCheck(checkId, contract, solution, seed) {
  try {
    if (checkId === 'answer_format') return runAnswerFormat(contract, solution);
    if (checkId === 'numeric_residual') return runNumericResidual(contract, solution);
    if (checkId === 'expression_sample') return runExpressionSample(contract, solution, seed);
    if (checkId === 'domain_probe') return runDomainProbe(contract, solution, seed);
    return { status: 'unknown', detail: `UNKNOWN_CHECK:${checkId}` };
  } catch (error) {
    return { status: 'unknown', detail: `CHECK_FAILED:${error?.message ?? error}` };
  }
}

function evidenceKindFor(check) {
  return CHECK_META[check]?.kind ?? null;
}

/** R5：answer.unit 缺失与 null 视为相同，避免同一份答案产生不同证据 id。 */
export function normalizeAnswer(solution) {
  const answer = solution?.answer;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer ?? null;
  return { ...answer, value: answer.value ?? null, unit: answer.unit ?? null };
}

/** R5：solution 内容哈希前规范化 answer（unit 省略等价 null）。 */
export function normalizeSolution(solution) {
  if (!solution || typeof solution !== 'object' || Array.isArray(solution)) return solution ?? null;
  return { ...solution, answer: normalizeAnswer(solution) };
}

function evidenceHashes({ contract, check, claim, kind, status, detail, seed, solution }) {
  const answerDigest = digest(normalizeAnswer(solution));
  // 证据只绑定「契约 + 检查 + claim + kind + 答案 + seed」：step 文本/evidence_refs
  // 在 verify 之后还会被完善，不应改变已产生证据的 id，否则 solver 无法回引。
  const inputDigest = digest({
    contract_id: contract?.contract_id ?? null,
    check,
    claim,
    kind,
    answer: answerDigest,
    seed: Number.isFinite(seed) ? seed : null,
  });
  const outputDigest = digest({ status, detail: String(detail) });
  const evidenceId = `ev_${sha256Hex(`${inputDigest}|${outputDigest}|${check}|${claim}|${kind}`).slice(0, 12)}`;
  return { inputDigest, outputDigest, evidenceId };
}

/**
 * 构造一条证据（kind 参与 input/output/evidence_id 的哈希，防止改 kind 伪造独立证据）。
 */
export function makeEvidence({ contract, check, claim, status, detail, seed, solution, at }) {
  const kind = check?.kind;
  if (!EVIDENCE_KINDS.includes(kind) || evidenceKindFor(check?.id) !== kind) {
    throw new TypeError(`非法或与 check 不匹配的证据种类 ${kind}`);
  }
  const hashes = evidenceHashes({ contract, check: check.id, claim, kind, status, detail, seed, solution });
  return {
    evidence_id: hashes.evidenceId,
    kind,
    check: check.id,
    claim,
    status,
    detail: String(detail),
    input_digest: hashes.inputDigest,
    output_digest: hashes.outputDigest,
    created_at: typeof at === 'string' ? at : new Date().toISOString(),
  };
}

/**
 * 重算一条 Evidence 记录的所有可重算字段。
 * finalize 与 audit 共用：kind 必须等于该 check 的固定 kind；input/output/evidence_id
 * 必须与 account 内容一致。任一项不符都返回 issue（调用方据此记 EVIDENCE_CONFLICT）。
 *
 * @param {object} record
 * @param {{contract?: object, solution?: object, seed?: number}} context
 * @returns {Array<{code: string, message: string}>}
 */
export function validateEvidenceRecord(record, { contract, solution, seed } = {}) {
  const issues = [];
  if (!record || typeof record !== 'object') {
    issues.push({ code: 'EVIDENCE_SHAPE', message: 'evidence 不是对象' });
    return issues;
  }
  const meta = CHECK_META[record.check];
  if (!meta) {
    issues.push({ code: 'EVIDENCE_CHECK', message: `未知 check: ${record.check}` });
    return issues;
  }
  if (record.kind !== meta.kind) {
    issues.push({ code: 'EVIDENCE_KIND', message: `${record.check} 的 kind 必须是 ${meta.kind}，实际 ${record.kind}` });
  }
  const expected = evidenceHashes({
    contract,
    check: record.check,
    claim: record.claim,
    kind: record.kind,
    status: record.status,
    detail: record.detail,
    seed,
    solution,
  });
  if (record.output_digest !== expected.outputDigest) {
    issues.push({ code: 'EVIDENCE_DIGEST', message: `${record.check} 的 output_digest 与 status/detail 不一致` });
  }
  if (record.input_digest !== expected.inputDigest) {
    issues.push({ code: 'EVIDENCE_DIGEST', message: `${record.check} 的 input_digest 与输入不一致` });
  }
  if (record.evidence_id !== expected.evidenceId) {
    issues.push({ code: 'EVIDENCE_ID', message: `${record.check} 的 evidence_id 与摘要不一致` });
  }
  return issues;
}

/**
 * 执行计划，生成证据数组。
 * @param {{contract: object, plan?: object[], solution: object, seed?: number}} input
 * @returns {object[]} Evidence[]
 */
export function runChecks({ contract, plan, solution, seed } = {}) {
  const checks = Array.isArray(plan) ? plan : buildPlan(contract);
  const effectiveSeed = Number.isFinite(seed) ? seed : contract?.verification?.seed ?? 42;
  const at = new Date().toISOString();
  const evidence = [];
  for (const check of checks) {
    if (!check || !CHECK_IDS.includes(check.id)) continue;
    const outcome = check.available
      ? executeCheck(check.id, contract, solution ?? {}, effectiveSeed)
      : { status: 'unknown', detail: `UNAVAILABLE:${check.reason ?? 'UNKNOWN'}` };
    evidence.push(makeEvidence({
      contract,
      check,
      claim: 'answer',
      status: outcome.status,
      detail: outcome.detail,
      seed: effectiveSeed,
      solution: solution ?? {},
      at,
    }));
  }
  return evidence;
}

/**
 * 证据摘要。
 * @param {object[]} evidence
 * @returns {{pass:number, fail:number, unknown:number, total:number, independent_kinds:string[]}}
 */
export function summarizeEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  let pass = 0;
  let fail = 0;
  let unknown = 0;
  const kinds = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.status === 'pass') {
      pass += 1;
      if (typeof item.kind === 'string' && item.kind !== 'structural' && EVIDENCE_KINDS.includes(item.kind)) {
        kinds.add(item.kind);
      }
    } else if (item.status === 'fail') fail += 1;
    else unknown += 1;
  }
  return {
    pass,
    fail,
    unknown,
    total: list.length,
    independent_kinds: [...kinds].sort(),
  };
}

/** 只保留指定 check id 的计划（工具 `checks` 参数用）。 */
export function filterPlan(plan, checks) {
  if (!Array.isArray(checks) || checks.length === 0) return plan;
  const allowed = new Set(checks);
  return plan.filter((check) => allowed.has(check.id));
}
