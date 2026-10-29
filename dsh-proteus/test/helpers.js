/**
 * 测试公共工具：不依赖 DSH、不联网、只写 mkdtemp 临时目录。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, sha256Hex } from '../lib/canonical.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = deepMerge(base[key], value);
    else out[key] = value;
  }
  return out;
}

/** 合法的 12 分考试契约（高考数学，微积分）。 */
export const BASE_CONTRACT = {
  schema: 'proteus.contract/v1',
  exam: 'gaokao-math',
  problem: { source: '2024 全国甲卷 理 21', text: '已知函数 f(x)=x^3-3x，求 f 的单调区间。' },
  domain: 'calculus',
  knowledge_points: ['GK.FUNC.DERIV'],
  problem_type: 'computation',
  givens: [{ id: 'G1', text: 'f(x)=x^3-3x', symbol: 'f', required: true }],
  goal: { kind: 'evaluate', statement: '求 f 的单调区间' },
  answer_format: { type: 'exact', tolerance: null, units: null },
  grading_rubric: {
    source: 'inferred',
    total_points: 12,
    answer_points: 2,
    step_points: [
      { id: 'S1', desc: '写出定义域', points: 2, required: true, evidence: ['structural'], partial: 'all_or_nothing' },
      { id: 'S2', desc: "求导并写出 f'(x)", points: 3, required: true, evidence: ['symbolic'], partial: 'half_on_missing' },
      { id: 'S3', desc: '列表判号', points: 3, required: true, evidence: ['numeric'], partial: 'proportional' },
      { id: 'S4', desc: '写出结论', points: 2, required: true, evidence: ['structural'], partial: 'all_or_nothing' },
    ],
    deduction_rules: [],
  },
  verification: {
    equations: ['x^2-5*x+6=0'],
    reference_expr: '2',
    variables: ['x'],
    sample_range: [-10, 10],
    seed: 42,
    checks: ['answer_format', 'numeric_residual', 'expression_sample', 'domain_probe'],
  },
  time_budget_s: 60,
  difficulty: 'medium',
  ambiguity: { severity: 'none', flags: [] },
  syllabus: { in_syllabus: true, out_of_syllabus: [] },
};

export function makeContract(overrides = {}) {
  return deepMerge(structuredClone(BASE_CONTRACT), overrides);
}

/** 集成测试用的完整解答；evidenceIds 用于把步骤回引到 verify 产生的证据。 */
export function makeSolution(evidenceIds = {}) {
  return {
    answer: { value: '2', unit: null },
    steps: [
      {
        id: 'S1',
        text: "定义域为 R，f'(x)=3x^2-3。",
        tags: ['domain', 'uses:G1'],
        evidence_refs: [],
      },
      {
        id: 'S2',
        text: "令 f'(x)=0，得 x=±1。",
        tags: ['theorem:fermat'],
        evidence_refs: evidenceIds.symbolic ? [evidenceIds.symbolic] : [],
      },
      {
        id: 'S3',
        text: "当 x<-1 或 x>1 时 f'(x)>0；当 -1<x<1 时 f'(x)<0。",
        tags: [],
        evidence_refs: evidenceIds.numeric ? [evidenceIds.numeric] : [],
      },
      {
        id: 'S4',
        text: '所以单调递增区间为 (-∞,-1) 和 (1,+∞)。',
        tags: [],
        evidence_refs: [],
      },
    ],
  };
}

/** 仅答案的最小解答（用于 verify 生成证据）。 */
export function answerOnlySolution(value = '2') {
  return { answer: { value, unit: null }, steps: [] };
}

/** 捕获工具注册、提示区块与效果的 fake ctx。 */
export function makeToolCtx({ logger } = {}) {
  const tools = [];
  const sections = [];
  const effects = [];
  const logs = [];
  const sink = logger ?? {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message) => logs.push({ level: 'warn', message }),
  };
  const ctx = {
    logger: sink,
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {
          const index = tools.indexOf(definition);
          if (index >= 0) tools.splice(index, 1);
        };
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {
          const index = sections.indexOf(section);
          if (index >= 0) sections.splice(index, 1);
        };
      },
    },
    effect(callback, label) {
      const disposer = callback();
      effects.push({ label, dispose: disposer });
      return () => {
        try {
          disposer?.();
        } catch {
          /* ignore */
        }
      };
    },
  };
  return { ctx, tools, sections, effects, logs };
}

export function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } } };
}

export function makeTempDir(prefix = 'proteus-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 在已注册工具表中找定义并按名调用。 */
export function findTool(tools, name) {
  const definition = tools.find((tool) => tool.name === name);
  if (!definition) throw new Error(`工具未注册: ${name}（已注册：${tools.map((tool) => tool.name).join(',')}）`);
  return definition;
}

export async function callTool(tools, name, args, exec) {
  return findTool(tools, name).execute(args, exec);
}

/**
 * 手工构造一条 Evidence 形状对象，仅用于终态判定函数（decideFinalState）单测。
 * 注意：audit 会校验 kind===CHECK_META[check].kind 并重跑，v0.1 不存在 symbolic
 * 适配器，因此这种对象不能用于 finalize/audit 的“伪造”路径。
 */
export function makeManualEvidence({
  kind = 'human',
  check = 'expression_sample',
  claim = 'answer',
  status = 'pass',
  detail = 'manual adapter evidence',
  at = '2026-01-01T00:00:00.000Z',
} = {}) {
  const inputDigest = digest({ contract_id: null, check, claim, kind, answer: digest(null), seed: null });
  const outputDigest = digest({ status, detail });
  const evidenceId = `ev_${sha256Hex(`${inputDigest}|${outputDigest}|${check}|${claim}|${kind}`).slice(0, 12)}`;
  return {
    evidence_id: evidenceId,
    kind,
    check,
    claim,
    status,
    detail,
    input_digest: inputDigest,
    output_digest: outputDigest,
    created_at: at,
  };
}

/** 宿主半侧 fake ctx：捕获 effect / inject 回调。 */
export function makeHostCtx() {
  const effects = [];
  const injects = [];
  const logs = [];
  const ctx = {
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    effect(callback, label) {
      const disposer = callback();
      effects.push({ label, dispose: disposer });
      return disposer;
    },
    inject(services, callback) {
      injects.push({ services, callback });
      return () => {};
    },
  };
  return { ctx, effects, injects, logs };
}
