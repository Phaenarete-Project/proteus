/**
 * 预设半侧入口 `dsh-proteus/tools`：按 role 注册限定作用域的 7 个工具 +
 * 一段 scoped systemPrompt 区块。
 *
 * 关键纪律：
 * - 工具用原始 ToolDefinition 注册（不依赖 DSH 的 defineTool DSL）。
 * - 注册与提示区块都通过 ctx.effect 托管，随插件卸载自动注销。
 * - 工具返回 `{ok:false,error:{code,message}}`，不 throw（除程序缺陷）。
 * - 跨调用状态全部落盘到 `<cwd>/<root>/`，重启可继续。
 * - cwd 必须收敛在会话工作区内，bundle_path 只允许 `<root>/audit/` 下。
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { defineConfig, withDefaults } from './config.js';
import { digest } from './canonical.js';
import {
  appendTimeline,
  auditPath,
  createLedger,
  currentEvidence,
  readLedger,
  resolveRoot,
  solutionPath,
  writeLedger,
  writeTextAtomic,
} from './store.js';
import { matrixCellKey, validateContract } from './contract.js';
import {
  cellStats,
  emptyCell,
  listCells,
  loadMatrix,
  matrixTotals,
  routeStrategy,
  saveMatrix,
  upsertOutcome,
  weakSiblings,
} from './matrix.js';
import { appendCheckpoint, checkBudget, DEFAULT_THRESHOLDS, startBudget } from './budget.js';
import {
  buildPlan,
  filterPlan,
  normalizeSolution,
  runChecks,
  summarizeEvidence,
  validateEvidenceRecord,
} from './evidence.js';
import { grade as gradeSolution, RULE_VERSION } from './rubric.js';
import {
  buildBundle,
  defaultEnvironment,
  readBundle,
  rerunBundleChecks,
  verifyBundle,
  verifyBundleSemantics,
  verifyBundleStructure,
  writeBundle,
} from './audit.js';
import { applyGradeDrift, decideFinalState } from './final-state.js';

export { decideFinalState };

export const name = 'proteus-tools';

export const Config = defineConfig((z) => z.object({
  role: z.string().default('full'),
  root: z.string().default('proteus'),
  evidenceMinKinds: z.number().default(2),
  targetAttempts: z.number().default(5),
}));

export const inject = ['tools', 'systemPrompt'];

export const PLUGIN_VERSION = '0.1.0';

export const TOOL_NAMES = [
  'proteus_contract',
  'proteus_route',
  'proteus_budget',
  'proteus_verify',
  'proteus_grade',
  'proteus_finalize',
  'proteus_audit',
];

/**
 * 角色 → 工具 → 允许 action。
 * 工具没出现在映射里就物理上不注册；已注册但 action 越权返回 ROLE_DENIED。
 * grade/finalize 没有 action 参数，用同名哨兵值表示允许。
 */
export const ROLE_ACTIONS = {
  full: {
    proteus_contract: ['create', 'validate', 'show'],
    proteus_route: ['lookup', 'stats'],
    proteus_budget: ['start', 'check', 'status'],
    proteus_verify: ['plan', 'run'],
    proteus_grade: ['grade'],
    proteus_finalize: ['finalize'],
    proteus_audit: ['write', 'verify', 'replay'],
  },
  contract: {
    proteus_contract: ['create', 'validate', 'show'],
    proteus_route: ['lookup'],
    proteus_budget: ['start', 'check', 'status'],
  },
  solver: {
    proteus_contract: ['show'],
    proteus_route: ['lookup'],
    proteus_budget: ['start', 'check', 'status'],
    proteus_verify: ['plan', 'run'],
  },
  grader: {
    proteus_contract: ['show'],
    proteus_route: ['lookup'],
    proteus_budget: ['status'],
    proteus_grade: ['grade'],
  },
  auditor: {
    proteus_contract: ['show'],
    proteus_route: ['stats'],
    proteus_budget: ['status'],
    proteus_audit: ['write', 'verify', 'replay'],
  },
};

const ROLE_FALLBACK = 'contract';

function normalizeRole(role) {
  if (typeof role !== 'string' || role.trim() === '') return 'full';
  const value = role.trim();
  return Object.prototype.hasOwnProperty.call(ROLE_ACTIONS, value) ? value : ROLE_FALLBACK;
}

function normalizeConfig(config) {
  const cfg = withDefaults(config, {
    role: 'full',
    root: 'proteus',
    evidenceMinKinds: 2,
    targetAttempts: 5,
  });
  cfg.role = normalizeRole(cfg.role);
  cfg.root = typeof cfg.root === 'string' && cfg.root.trim() !== '' ? cfg.root : 'proteus';
  // evidenceMinKinds 下限锁 2：v0.1 只有 numeric 一种介质，配置成 1 会让
  // 「单路证据」冒充 Verified；该配置不提供给部署方作为降门槛开关。
  cfg.evidenceMinKinds = Number.isFinite(cfg.evidenceMinKinds)
    ? Math.max(2, Math.floor(cfg.evidenceMinKinds))
    : 2;
  cfg.targetAttempts = Number.isFinite(cfg.targetAttempts) && cfg.targetAttempts > 0
    ? cfg.targetAttempts
    : 5;
  return cfg;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * R2：realpath 感知。目标存在时直接 realpath；不存在时向上找最近存在的祖先，
 * realpath 后再拼回缺失的相对部分。用于 cwd / bundle_path 的边界比较。
 */
function realpathDeep(target) {
  const resolved = resolvePath(target);
  let current = resolved;
  const suffix = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return suffix.length > 0 ? join(real, ...suffix.reverse()) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return resolved;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

/**
 * M9：工作区收敛。args.cwd 必须等于或位于会话工作区之下；无会话工作区时以
 * process.cwd() 为根，只允许其子目录。
 * @returns {{cwd: string, rootDir: string}}
 */
function resolveWorkspace(args, exec, cfg) {
  const sessionCwd = exec?.agent?.session?.header?.cwd;
  const declaredBase = resolvePath(typeof sessionCwd === 'string' && sessionCwd.trim() !== '' ? sessionCwd : process.cwd());
  const base = realpathDeep(declaredBase);
  let cwd = base;
  const requested = args?.cwd;
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    if (typeof requested !== 'string') throw fail('INVALID_ARGUMENT', 'cwd 必须是字符串');
    cwd = realpathDeep(resolvePath(base, requested));
    if (!isWithin(cwd, base)) throw fail('PATH_DENIED', `cwd 越界：${requested}`);
  }
  return { cwd, rootDir: resolveRoot(cwd, cfg.root) };
}

function resolveBundleFile(args, workspace, rootDir) {
  if (typeof args?.bundle_path === 'string' && args.bundle_path.trim() !== '') {
    const file = realpathDeep(resolvePath(workspace.cwd, args.bundle_path));
    const auditDir = realpathDeep(join(rootDir, 'audit'));
    if (!isWithin(file, auditDir)) {
      throw fail('PATH_DENIED', 'bundle_path 只允许 <root>/audit/ 下的文件');
    }
    return file;
  }
  return auditPath(rootDir, requireContractId(args));
}

function requireContractId(args) {
  if (typeof args?.contract_id !== 'string' || args.contract_id.trim() === '') {
    throw fail('CONTRACT_ID_REQUIRED', 'contract_id 必填');
  }
  return args.contract_id.trim();
}

function requireLedger(rootDir, contractId) {
  const ledger = readLedger(rootDir, contractId);
  if (ledger === null) throw fail('LEDGER_NOT_FOUND', `未找到契约账本: ${contractId}`);
  return ledger;
}

function requireSolution(args) {
  if (!isObject(args?.solution)) throw fail('SOLUTION_REQUIRED', 'solution 必填（含 answer 与 steps）');
  return args.solution;
}

function requireAction(args, ctx, tool, actions) {
  const action = args?.action;
  if (typeof action !== 'string' || !actions.includes(action)) {
    throw fail('INVALID_ACTION', `action 必须是 ${actions.join(' / ')}`);
  }
  const permitted = ROLE_ACTIONS[ctx.role]?.[tool] ?? [];
  if (!permitted.includes(action)) {
    throw fail('ROLE_DENIED', `角色 ${ctx.role} 不允许 ${tool}:${action}`);
  }
  return action;
}

function requireTool(ctx, tool) {
  const permitted = ROLE_ACTIONS[ctx.role]?.[tool];
  if (!permitted || permitted.length === 0) {
    throw fail('ROLE_DENIED', `角色 ${ctx.role} 不允许使用 ${tool}`);
  }
}

function nextForState(state) {
  if (state === 'ready') return 'solve';
  if (state === 'ambiguous') return 'clarify';
  return 'stop';
}

function buildRouting(contract, rootDir, cfg) {
  const cellKey = matrixCellKey(contract);
  let metrics;
  try {
    const matrix = loadMatrix(rootDir);
    metrics = cellStats(matrix.cells?.[cellKey] ?? emptyCell(contract), cfg.targetAttempts);
  } catch {
    metrics = cellStats(emptyCell(contract), cfg.targetAttempts);
  }
  return { cell_key: cellKey, strategy: routeStrategy(contract).id, priority: metrics.priority };
}

function resolveModel(exec) {
  const fromSession = exec?.agent?.session?.header?.model;
  if (typeof fromSession === 'string' && fromSession.trim() !== '') return fromSession;
  const fromEnv = process.env.DSH_MODEL;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return 'unknown';
}

function finalAnswerPayload(solution) {
  if (!isObject(solution?.answer)) return null;
  return { value: solution.answer.value ?? null, unit: solution.answer.unit ?? null };
}

/** 当前 attempt 的 seed：ledger 记录优先，回退契约 seed，最后 42。 */
function attemptSeed(ledger) {
  if (Number.isFinite(ledger?.verification?.seed)) return ledger.verification.seed;
  const contractSeed = ledger?.contract?.verification?.seed;
  return Number.isFinite(contractSeed) ? contractSeed : 42;
}

/** 当前 attempt 的 plan id 列表；没有 verification 时返回 null（回退全量）。 */
function attemptPlanIds(ledger) {
  const plan = ledger?.verification?.plan;
  return Array.isArray(plan) ? plan.map(String) : null;
}

/**
 * B1：校验当前 attempt 的证据，并重跑 checks 逐条比对。
 * @returns {{issues: object[], rerun: object[]}}
 */
function verifyAttemptEvidence({ contract, solution, evidence, planIds, seed }) {
  const issues = [];
  for (const record of evidence) {
    for (const item of validateEvidenceRecord(record, { contract, solution, seed })) {
      issues.push(item);
    }
  }
  const plan = filterPlan(buildPlan(contract), planIds ?? undefined);
  const rerun = runChecks({ contract, plan, solution, seed });
  const ledgerById = new Map(evidence.map((item) => [item.evidence_id, item]));
  const rerunById = new Map(rerun.map((item) => [item.evidence_id, item]));
  for (const [id, record] of ledgerById) {
    const actual = rerunById.get(id);
    if (!actual) {
      issues.push({ code: 'EVIDENCE_MISSING', message: `账本证据 ${id} 未被重跑产出` });
      continue;
    }
    if (record.kind !== actual.kind || record.status !== actual.status || record.claim !== actual.claim) {
      issues.push({ code: 'EVIDENCE_MISMATCH', message: `账本证据 ${id} 的 kind/status/claim 与重跑不一致` });
    }
  }
  for (const id of rerunById.keys()) {
    if (!ledgerById.has(id)) issues.push({ code: 'EVIDENCE_EXTRA', message: `重跑产出的证据 ${id} 不在当前 attempt` });
  }
  return { issues, rerun };
}

/** B1/B2：solution 的 evidence_refs 必须都能在当前 attempt 证据里解析。 */
function danglingEvidenceRefs(solution, evidence) {
  const ids = new Set(evidence.map((item) => item.evidence_id));
  const issues = [];
  for (const step of Array.isArray(solution?.steps) ? solution.steps : []) {
    if (!step || !Array.isArray(step.evidence_refs)) continue;
    for (const reference of step.evidence_refs) {
      if (!ids.has(reference)) {
        issues.push({ code: 'DANGLING_EVIDENCE_REF', message: `步骤 ${step.id ?? '(无 id)'} 引用了不存在的证据 ${reference}` });
      }
    }
  }
  return issues;
}

function renderSolutionMarkdown({ contract, solution, gradeResult, state, reasonCodes, at, solutionFile, bundleFile, verification }) {
  const problem = contract?.problem ?? {};
  const rubric = contract?.grading_rubric ?? {};
  const lines = [];
  lines.push(`# Proteus 解答${problem.source ? `：${problem.source}` : ''}`);
  lines.push('');
  lines.push('## 契约摘要');
  lines.push('');
  lines.push(`- contract_id：\`${contract?.contract_id ?? ''}\``);
  lines.push(`- 考试 / 领域：${contract?.exam ?? '-'} / ${contract?.domain ?? '-'}`);
  lines.push(`- 知识点：${(contract?.knowledge_points ?? []).join(', ') || '-'}`);
  lines.push(`- 题型 / 难度：${contract?.problem_type ?? '-'} / ${contract?.difficulty ?? '-'}`);
  lines.push(`- 总分 / 答案分：${rubric.total_points ?? 0} / ${rubric.answer_points ?? 0}`);
  lines.push('');
  lines.push('## 题目');
  lines.push('');
  lines.push(String(problem.text ?? ''));
  lines.push('');
  lines.push('## 答案');
  lines.push('');
  const answerValue = solution?.answer?.value;
  const unit = solution?.answer?.unit;
  lines.push(`\`${typeof answerValue === 'string' ? answerValue : JSON.stringify(answerValue ?? null)}\`${unit ? ` ${unit}` : ''}`);
  lines.push('');
  lines.push('## 步骤');
  lines.push('');
  const scores = new Map((Array.isArray(gradeResult?.step_scores) ? gradeResult.step_scores : []).map((item) => [item.id, item]));
  const steps = Array.isArray(solution?.steps) ? solution.steps : [];
  if (steps.length === 0) {
    lines.push('（未提交步骤）');
  } else {
    for (const step of steps) {
      const score = scores.get(step.id);
      const kinds = Array.isArray(score?.kinds) && score.kinds.length > 0 ? score.kinds.join(',') : 'heuristic';
      lines.push(`### ${step.id ?? '(无 id)'}（${score?.earned ?? 0}/${score?.max ?? 0}）〔${kinds}〕`);
      lines.push('');
      lines.push(String(step.text ?? ''));
      if (Array.isArray(step.tags) && step.tags.length > 0) {
        lines.push('');
        lines.push(`tags: ${step.tags.map(String).join(', ')}`);
      }
      if (Array.isArray(step.evidence_refs) && step.evidence_refs.length > 0) {
        lines.push('');
        lines.push(`evidence_refs: ${step.evidence_refs.map(String).join(', ')}`);
      }
      lines.push('');
    }
  }
  lines.push('## 评分预测（规则分为准，不是权威）');
  lines.push('');
  lines.push(`- 预测得分：${gradeResult?.predicted_points ?? 0} / ${gradeResult?.max_points ?? rubric.total_points ?? 0}`);
  lines.push(`- 答案分：${gradeResult?.answer_points ?? 0} / ${rubric.answer_points ?? 0}`);
  lines.push(`- 置信度：${gradeResult?.confidence ?? 0}`);
  lines.push(`- 独立证据种类：${(gradeResult?.independent_kinds ?? []).join(', ') || '(无)'}`);
  lines.push(`- 覆盖：${gradeResult?.coverage?.steps_verified ?? 0} / ${gradeResult?.coverage?.steps_total ?? 0} 步`);
  lines.push('');
  if (Array.isArray(gradeResult?.step_scores) && gradeResult.step_scores.length > 0) {
    lines.push('| 步骤 | 得分 / 满分 | 理由 |');
    lines.push('|---|---|---|');
    for (const step of gradeResult.step_scores) {
      lines.push(`| ${step.id} | ${step.earned} / ${step.max} | ${String(step.reason ?? '').replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  if (Array.isArray(gradeResult?.deductions) && gradeResult.deductions.length > 0) {
    lines.push('扣分项：');
    for (const deduction of gradeResult.deductions) {
      lines.push(`- ${deduction.trap} -${deduction.points}：${deduction.reason}`);
    }
    lines.push('');
  }
  lines.push('## 验证状态');
  lines.push('');
  lines.push(`**${state}**${reasonCodes.length > 0 ? `（${reasonCodes.join(', ')}）` : ''}`);
  lines.push('');
  lines.push('## 陷阱检查');
  lines.push('');
  const traps = Array.isArray(gradeResult?.traps) ? gradeResult.traps : [];
  if (traps.length === 0) lines.push('- 未命中受控陷阱');
  else {
    for (const trap of traps) {
      lines.push(`- ${trap.trap} [${trap.severity}/${trap.basis}] ${trap.detail}`);
    }
  }
  lines.push('');
  lines.push('## 证据');
  lines.push('');
  const evidence = Array.isArray(gradeResult?.evidence) ? gradeResult.evidence : [];
  if (evidence.length === 0) lines.push('（无证据）');
  else {
    for (const item of evidence) {
      lines.push(`- [${item.status}] ${item.check} / ${item.kind}：${item.detail}（\`${item.evidence_id}\`）`);
    }
  }
  lines.push('');
  lines.push('## 审计');
  lines.push('');
  lines.push(`- attempt：${verification?.attempt ?? '-'}；plan：${(verification?.plan ?? []).join(', ') || '-'}；seed：${verification?.seed ?? '-'}`);
  lines.push(`- 解答文件：\`${solutionFile ?? ''}\``);
  lines.push(`- 审计包：\`${bundleFile ?? ''}\``);
  lines.push(`- 规则版本：${RULE_VERSION}；生成时间：${at}`);
  lines.push('');
  return lines.join('\n');
}

// ── 工具处理函数 ────────────────────────────────────────────────────────────

async function handleContract(args, exec, ctx) {
  const action = requireAction(args, ctx, 'proteus_contract', ['create', 'validate', 'show']);
  const workspace = resolveWorkspace(args, exec, ctx.cfg);
  if (action === 'show') {
    const contractId = requireContractId(args);
    const ledger = requireLedger(workspace.rootDir, contractId);
    return {
      ok: true,
      contract: ledger.contract,
      state: validateContract(ledger.contract).state,
      ledger_state: ledger.state,
      evidence_count: Array.isArray(ledger.evidence) ? ledger.evidence.length : 0,
      grade: ledger.grade,
      final: ledger.final,
    };
  }
  if (!isObject(args.contract)) throw fail('CONTRACT_REQUIRED', 'contract 必填（对象）');
  const validation = validateContract(args.contract);
  const { ok, issues, contract, state } = validation;
  const routing = buildRouting(contract, workspace.rootDir, ctx.cfg);
  const next = nextForState(state);
  if (action === 'validate' || !ok) {
    if (!ok) {
      return {
        ok: false,
        error: { code: 'CONTRACT_INVALID', message: '契约校验未通过（存在 error 级问题）' },
        contract_id: contract.contract_id,
        state,
        issues,
        contract,
        routing,
        next,
      };
    }
    return { ok: true, contract_id: contract.contract_id, state, issues, contract, routing, next, persisted: false };
  }

  const existing = readLedger(workspace.rootDir, contract.contract_id);
  if (existing !== null) {
    const existingValidation = validateContract(existing.contract);
    return {
      ok: true,
      existing: true,
      persisted: true,
      contract_id: contract.contract_id,
      state: existingValidation.state,
      issues: existingValidation.issues,
      contract: existingValidation.contract,
      routing: buildRouting(existingValidation.contract, workspace.rootDir, ctx.cfg),
      next: nextForState(existingValidation.state),
    };
  }

  const ledger = createLedger(contract);
  appendTimeline(ledger, 'contract.created', new Date());
  writeLedger(workspace.rootDir, ledger);
  return {
    ok: true,
    existing: false,
    persisted: true,
    contract_id: contract.contract_id,
    state,
    issues,
    contract,
    routing,
    next,
  };
}

async function handleRoute(args, exec, ctx) {
  const action = requireAction(args, ctx, 'proteus_route', ['lookup', 'stats']);
  const workspace = resolveWorkspace(args, exec, ctx.cfg);
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 10;
  if (action === 'stats') {
    const matrix = loadMatrix(workspace.rootDir);
    const listed = listCells(matrix, { targetAttempts: ctx.cfg.targetAttempts, limit });
    return {
      ok: true,
      totals: matrixTotals(matrix),
      cells: listed.cells.slice(0, limit),
      weakest: listed.weakest,
    };
  }
  const contractId = requireContractId(args);
  const ledger = requireLedger(workspace.rootDir, contractId);
  const matrix = loadMatrix(workspace.rootDir);
  const cellKey = matrixCellKey(ledger.contract);
  const cell = matrix.cells?.[cellKey] ?? emptyCell(ledger.contract);
  const metrics = cellStats(cell, ctx.cfg.targetAttempts);
  return {
    ok: true,
    cell_key: cellKey,
    cell,
    metrics,
    priority: metrics.priority,
    strategy: routeStrategy(ledger.contract),
    weak_siblings: weakSiblings(matrix, ledger.contract),
  };
}

async function handleBudget(args, exec, ctx) {
  const action = requireAction(args, ctx, 'proteus_budget', ['start', 'check', 'status']);
  const workspace = resolveWorkspace(args, exec, ctx.cfg);
  const contractId = requireContractId(args);
  const ledger = requireLedger(workspace.rootDir, contractId);
  const now = new Date();
  if (action === 'status') {
    return {
      ok: true,
      budget: ledger.budget ?? null,
      state: ledger.budget ? checkBudget(ledger.budget, now, DEFAULT_THRESHOLDS) : null,
    };
  }
  if (action === 'start') {
    if (ledger.budget && args.restart !== true) {
      throw fail('BUDGET_ALREADY_STARTED', '预算已起表；如需重置必须显式传 restart=true');
    }
    const restart = ledger.budget !== null && ledger.budget !== undefined;
    const budget = startBudget(ledger.contract, now);
    if (typeof args.stage === 'string' && args.stage.trim() !== '') budget.stage = args.stage.trim();
    ledger.budget = budget;
    appendTimeline(ledger, restart ? 'budget.restarted' : 'budget.started', now);
    writeLedger(workspace.rootDir, ledger);
    return { ok: true, restarted: restart, budget, state: checkBudget(budget, now, DEFAULT_THRESHOLDS) };
  }
  if (!ledger.budget) throw fail('BUDGET_NOT_STARTED', '预算尚未 start');
  const state = checkBudget(ledger.budget, now, DEFAULT_THRESHOLDS);
  const checkpoint = appendCheckpoint(ledger.budget, state, args.stage);
  appendTimeline(ledger, 'budget.checkpoint', now);
  writeLedger(workspace.rootDir, ledger);
  return { ok: true, budget: ledger.budget, checkpoint, ...state };
}

async function handleVerify(args, exec, ctx) {
  const action = requireAction(args, ctx, 'proteus_verify', ['plan', 'run']);
  const workspace = resolveWorkspace(args, exec, ctx.cfg);
  const contractId = requireContractId(args);
  const ledger = requireLedger(workspace.rootDir, contractId);
  let plan = buildPlan(ledger.contract);
  if (Array.isArray(args.checks)) plan = filterPlan(plan, args.checks);
  if (action === 'plan') return { ok: true, checks: plan };

  if (ledger.state === 'finalized') throw fail('LEDGER_FINALIZED', '契约已定稿，不能追加证据');
  const solution = requireSolution(args);
  const seed = Number.isFinite(args.seed) ? args.seed : attemptSeed(ledger);
  const planIds = plan.map((check) => check.id);
  const produced = runChecks({ contract: ledger.contract, plan, solution, seed });
  const existing = new Set((Array.isArray(ledger.evidence) ? ledger.evidence : []).map((item) => item?.evidence_id));
  const fresh = produced.filter((item) => !existing.has(item.evidence_id));
  ledger.evidence = [...(Array.isArray(ledger.evidence) ? ledger.evidence : []), ...fresh];
  ledger.verification = {
    attempt: (Number.isFinite(ledger.verification?.attempt) ? ledger.verification.attempt : 0) + 1,
    plan: planIds,
    seed,
    evidence_ids: produced.map((item) => item.evidence_id),
  };
  if (ledger.state === 'created') ledger.state = 'verified';
  appendTimeline(ledger, 'evidence.appended', new Date());
  writeLedger(workspace.rootDir, ledger);

  const attemptEvidence = currentEvidence(ledger);
  const summary = summarizeEvidence(attemptEvidence);
  return {
    ok: true,
    evidence: produced,
    summary,
    independent_kinds: summary.independent_kinds,
    attempt: ledger.verification.attempt,
    plan: planIds,
    appended: fresh.length,
    evidence_total: ledger.evidence.length,
  };
}

async function handleGrade(args, exec, ctx) {
  requireTool(ctx, 'proteus_grade');
  const workspace = resolveWorkspace(args, exec, ctx.cfg);
  const contractId = requireContractId(args);
  const ledger = requireLedger(workspace.rootDir, contractId);
  if (ledger.state === 'finalized') throw fail('LEDGER_FINALIZED', '契约已定稿，不能重新评分');
  const solution = requireSolution(args);
  const evidence = currentEvidence(ledger);
  const result = gradeSolution({ contract: ledger.contract, solution, evidence });
  ledger.grade = result;
  appendTimeline(ledger, 'grade.predicted', new Date());
  writeLedger(workspace.rootDir, ledger);
  return { ok: true, ...result, attempt: Number.isFinite(ledger.verification?.attempt) ? ledger.verification.attempt : null };
}

async function handleFinalize(args, exec, ctx) {
  requireTool(ctx, 'proteus_finalize');
  const workspace = resolveWorkspace(args, exec, ctx.cfg);
  const contractId = requireContractId(args);
  const ledger = requireLedger(workspace.rootDir, contractId);
  const solution = requireSolution(args);

  // M2：重复 finalize 幂等/拒绝
  if (ledger.state === 'finalized') {
    if (ledger.final && typeof ledger.final === 'object'
      && digest(normalizeSolution(ledger.final.solution)) === digest(normalizeSolution(solution))) {
      return {
        ok: true,
        idempotent: true,
        state: ledger.final.state,
        reason_codes: ledger.final.reason_codes ?? [],
        answer: ledger.final.answer ?? finalAnswerPayload(solution),
        predicted_points: ledger.final.predicted_points,
        max_points: ledger.final.max_points,
        evidence_summary: ledger.final.evidence_summary ?? summarizeEvidence(currentEvidence(ledger)),
        solution_path: ledger.final.solution_path,
        audit_path: ledger.final.audit_path,
        attempt: ledger.final.attempt ?? null,
        warnings: [],
      };
    }
    throw fail('ALREADY_FINALIZED', '该契约已定稿且提交的 solution 不同；请为不同解答新建契约');
  }

  // R4：没有 verify 的 finalize 不能产出半成品审计包。
  if (!ledger.verification
    || !Array.isArray(ledger.verification.evidence_ids)
    || ledger.verification.evidence_ids.length === 0) {
    throw fail('VERIFICATION_REQUIRED', '先调用 proteus_verify run 生成当前 attempt 的证据，再 finalize');
  }

  const contractValidation = validateContract(ledger.contract);
  if (contractValidation.state === 'invalid') {
    throw fail('CONTRACT_INVALID', '账本中的契约已不合法，无法定稿');
  }

  const at = new Date();
  const atIso = at.toISOString();
  const evidence = currentEvidence(ledger);
  const recordIds = new Set((Array.isArray(ledger.evidence) ? ledger.evidence : []).map((item) => item?.evidence_id));
  const attemptEvidenceIds = Array.isArray(ledger.verification?.evidence_ids) ? ledger.verification.evidence_ids : null;
  const evidenceIssues = [];
  if (attemptEvidenceIds) {
    for (const id of attemptEvidenceIds) {
      if (!recordIds.has(id)) evidenceIssues.push({ code: 'EVIDENCE_MISSING', message: `attempt 记录的证据 ${id} 不在 ledger.evidence 中` });
    }
  }
  const seed = attemptSeed(ledger);
  const planIds = attemptPlanIds(ledger);
  const attemptCheck = verifyAttemptEvidence({ contract: ledger.contract, solution, evidence, planIds, seed });
  evidenceIssues.push(...attemptCheck.issues);
  evidenceIssues.push(...danglingEvidenceRefs(solution, evidence));
  const evidenceConflict = evidenceIssues.length > 0;

  const recomputed = gradeSolution({ contract: ledger.contract, solution, evidence });
  let gradeDrift = false;
  if (ledger.grade && typeof ledger.grade === 'object') {
    gradeDrift = ledger.grade.prediction_id !== recomputed.prediction_id
      || ledger.grade.max_points !== recomputed.max_points
      || Math.abs((ledger.grade.predicted_points ?? 0) - recomputed.predicted_points) > 1e-9;
  }
  const summary = summarizeEvidence(evidence);
  const budgetState = ledger.budget ? checkBudget(ledger.budget, at, DEFAULT_THRESHOLDS) : null;
  let decision = decideFinalState({
    contract: ledger.contract,
    solution,
    evidence,
    gradeResult: { ...recomputed, traps: recomputed.traps },
    budgetState,
    evidenceMinKinds: ctx.cfg.evidenceMinKinds,
  });
  decision = applyGradeDrift(decision, gradeDrift);
  if (evidenceConflict) {
    decision = {
      state: decision.state === 'Verified' ? 'LowConfidence' : decision.state,
      reason_codes: [...new Set([...decision.reason_codes, 'EVIDENCE_CONFLICT'])],
    };
  }
  const finalState = decision.state;
  const reasonCodes = decision.reason_codes;

  const solutionFile = solutionPath(workspace.rootDir, contractId);
  const bundleFile = auditPath(workspace.rootDir, contractId);
  const verification = ledger.verification && typeof ledger.verification === 'object'
    ? {
      attempt: ledger.verification.attempt ?? null,
      plan: Array.isArray(ledger.verification.plan) ? ledger.verification.plan.map(String) : [],
      seed,
    }
    : null;

  ledger.grade = recomputed;
  ledger.final = {
    state: finalState,
    reason_codes: reasonCodes,
    decided_at: atIso,
    solution,
    grade: recomputed,
    answer: finalAnswerPayload(solution),
    evidence_summary: summary,
    predicted_points: recomputed.predicted_points,
    max_points: recomputed.max_points,
    budget_check: budgetState,
    solution_path: solutionFile,
    audit_path: bundleFile,
    attempt: verification?.attempt ?? null,
    grade_drift: gradeDrift,
    evidence_conflict: evidenceConflict,
    evidence_issues: evidenceIssues,
  };

  // M11：先写完成事件并置 finalized（内存），再落盘，保证包内含 finalize.completed。
  appendTimeline(ledger, 'finalize.completed', at);
  ledger.state = 'finalized';

  const markdown = renderSolutionMarkdown({
    contract: ledger.contract,
    solution,
    gradeResult: { ...recomputed, evidence },
    state: finalState,
    reasonCodes,
    at: atIso,
    solutionFile,
    bundleFile,
    verification,
  });
  const environment = defaultEnvironment(ledger.contract, {
    model: resolveModel(exec),
    plugin_version: PLUGIN_VERSION,
    seed,
    evidence_min_kinds: ctx.cfg.evidenceMinKinds,
  });

  // R3：先更新矩阵；失败即中止，此时尚未写入 solution/audit 文件。
  try {
    const matrix = loadMatrix(workspace.rootDir);
    const nextMatrix = upsertOutcome(matrix, {
      contract: ledger.contract,
      state: finalState,
      predicted: recomputed,
      elapsed_s: budgetState ? budgetState.elapsed_s : null,
      at: atIso,
    });
    saveMatrix(workspace.rootDir, nextMatrix);
  } catch (error) {
    throw fail('MATRIX_WRITE_FAILED', `矩阵更新失败，定稿中止: ${error?.message ?? error}`);
  }

  writeTextAtomic(solutionFile, markdown);
  const bundle = buildBundle({ ledger, environment, at });
  writeBundle(workspace.rootDir, bundle);

  writeLedger(workspace.rootDir, ledger);
  return {
    ok: true,
    idempotent: false,
    state: finalState,
    reason_codes: reasonCodes,
    answer: finalAnswerPayload(solution),
    predicted_points: recomputed.predicted_points,
    max_points: recomputed.max_points,
    evidence_summary: summary,
    solution_path: solutionFile,
    audit_path: bundleFile,
    attempt: verification?.attempt ?? null,
    evidence_conflict: evidenceConflict,
    evidence_issues: evidenceIssues,
    warnings: [],
  };
}

function diffKindFor(code) {
  if (typeof code !== 'string') return 'bundle';
  if (code.startsWith('EVIDENCE') || code === 'DANGLING_EVIDENCE_REF') return 'evidence';
  if (code === 'GRADE_MISMATCH') return 'grade';
  if (code === 'STATE_MISMATCH' || code === 'BUDGET_STATE_CONFLICT') return 'state';
  if (code === 'INVALID_CONTRACT' || code.startsWith('CONTRACT_')) return 'contract';
  return 'bundle';
}

async function handleAudit(args, exec, ctx) {
  const action = requireAction(args, ctx, 'proteus_audit', ['write', 'verify', 'replay']);
  const workspace = resolveWorkspace(args, exec, ctx.cfg);

  if (action === 'write') {
    const contractId = requireContractId(args);
    const ledger = requireLedger(workspace.rootDir, contractId);
    if (!ledger.final || typeof ledger.final !== 'object') {
      throw fail('FINALIZE_REQUIRED', '账本尚未 finalize，无法生成审计包');
    }
    const target = auditPath(workspace.rootDir, contractId);
    // M11：已有且仍可 verify 的审计包不覆盖。
    if (existsSync(target)) {
      try {
        const existing = readBundle(target);
        const checked = verifyBundle(existing, { evidenceMinKinds: ctx.cfg.evidenceMinKinds });
        if (checked.ok) {
          return { ok: true, existing: true, bundle_id: existing.bundle_id ?? null, path: target };
        }
      } catch {
        /* 旧包损坏：允许重建 */
      }
    }
    const environment = defaultEnvironment(ledger.contract, {
      model: resolveModel(exec),
      plugin_version: PLUGIN_VERSION,
      seed: attemptSeed(ledger),
      evidence_min_kinds: ctx.cfg.evidenceMinKinds,
    });
    const bundle = buildBundle({ ledger, environment, at: new Date() });
    writeBundle(workspace.rootDir, bundle);
    return { ok: true, existing: false, bundle_id: bundle.bundle_id, path: target };
  }

  const bundleFile = resolveBundleFile(args, workspace, workspace.rootDir);
  const bundle = readBundle(bundleFile);
  if (bundle === null) throw fail('BUNDLE_NOT_FOUND', `未找到审计包: ${bundleFile}`);

  if (action === 'verify') {
    const result = verifyBundle(bundle, { evidenceMinKinds: ctx.cfg.evidenceMinKinds });
    return { ok: result.ok, bundle_id: bundle.bundle_id ?? null, issues: result.issues, path: bundleFile };
  }

  const structure = verifyBundleStructure(bundle);
  if (structure.some((item) => item.level === 'error')) {
    return {
      ok: false,
      error: { code: 'BUNDLE_INVALID', message: '审计包完整性校验失败，拒绝 replay' },
      issues: structure,
      path: bundleFile,
    };
  }
  const semantic = verifyBundleSemantics(bundle, { evidenceMinKinds: ctx.cfg.evidenceMinKinds });
  const rerun = rerunBundleChecks(bundle);
  return {
    ok: semantic.length === 0,
    checks: rerun.evidence.map((item) => ({
      check: item.check,
      claim: item.claim,
      status: item.status,
      kind: item.kind,
      evidence_id: item.evidence_id,
    })),
    diffs: semantic.map((item) => ({ kind: diffKindFor(item.code), code: item.code, message: item.message })),
    plan: rerun.plan.map((check) => check.id),
    seed: rerun.seed,
    path: bundleFile,
  };
}

// ── 工具定义与注册 ──────────────────────────────────────────────────────────

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

function renderOutput(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

const CONTRACT_PARAMS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'validate', 'show'], description: 'create 落盘并进入求解；validate 只校验；show 读账本' },
    contract: { type: 'object', additionalProperties: true, description: '考试契约对象（create/validate 必填）' },
    contract_id: { type: 'string', description: 'show 必填' },
    cwd: { type: 'string', description: '覆盖会话工作区（必须位于会话工作区内）' },
  },
  required: ['action'],
  additionalProperties: false,
};

const ROUTE_PARAMS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['lookup', 'stats'] },
    contract_id: { type: 'string', description: 'lookup 必填' },
    cwd: { type: 'string' },
    limit: { type: 'number', description: 'stats 返回的格子数，默认 10' },
  },
  required: ['action'],
  additionalProperties: false,
};

const BUDGET_PARAMS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'check', 'status'] },
    contract_id: { type: 'string' },
    cwd: { type: 'string' },
    stage: { type: 'string', description: '阶段名，如 solve/verify/finalize' },
    restart: { type: 'boolean', description: '仅在需要显式重置预算时传 true' },
  },
  required: ['action'],
  additionalProperties: false,
};

const VERIFY_PARAMS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['plan', 'run'] },
    contract_id: { type: 'string' },
    solution: { type: 'object', additionalProperties: true, description: '§2.2 Solution（run 必填）' },
    checks: {
      type: 'array',
      items: { type: 'string', enum: ['answer_format', 'numeric_residual', 'expression_sample', 'domain_probe'] },
      description: '可选：只跑指定检查；会写入 verification.plan 供 replay 复现',
    },
    seed: { type: 'number', description: '可选：覆盖采样种子；会写入 ledger 与审计包' },
    cwd: { type: 'string' },
  },
  required: ['action', 'contract_id'],
  additionalProperties: false,
};

const GRADE_PARAMS = {
  type: 'object',
  properties: {
    contract_id: { type: 'string' },
    solution: { type: 'object', additionalProperties: true, description: '§2.2 Solution' },
    cwd: { type: 'string' },
  },
  required: ['contract_id', 'solution'],
  additionalProperties: false,
};

const AUDIT_PARAMS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['write', 'verify', 'replay'] },
    contract_id: { type: 'string' },
    bundle_path: { type: 'string', description: '可选：只允许 <root>/audit/ 下的路径' },
    cwd: { type: 'string' },
  },
  required: ['action'],
  additionalProperties: false,
};

const TOOL_DEFINITIONS = {
  proteus_contract: {
    name: 'proteus_contract',
    description: '考试契约工具。create：校验并把契约写入账本，返回 contract_id、state、issues、路由与 next（solve/clarify/stop）；validate：只校验；show：读取账本，返回契约状态 state 与账本生命周期 ledger_state。有 error 级问题时不会落盘。',
    parameters: CONTRACT_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    timeoutMs: 30000,
    execute: handleContract,
  },
  proteus_route: {
    name: 'proteus_route',
    description: '考试矩阵路由。lookup：按 contract_id 返回格子、五项指标、优先级、解题策略与弱兄弟格；stats：返回全局 totals、按 priority 降序的 cells 与 weakest。',
    parameters: ROUTE_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    timeoutMs: 30000,
    execute: handleRoute,
  },
  proteus_budget: {
    name: 'proteus_budget',
    description: '时间预算。start 从契约 time_budget_s 起表（每个契约只能成功一次，重置须 restart=true）；check 追加 checkpoint 并返回 phase/remaining/allow_verified 等；status 只读。phase=exhausted 时不要把答案标成 Verified。',
    parameters: BUDGET_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    timeoutMs: 30000,
    execute: handleBudget,
  },
  proteus_verify: {
    name: 'proteus_verify',
    description: '多路验证。plan：列出可用检查；run：执行检查、把 Evidence 写入账本并记录 attempt（plan/seed/evidence_ids），返回 evidence、summary、独立证据种类与 attempt。证据只能由本工具产生。',
    parameters: VERIFY_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    timeoutMs: 60000,
    execute: handleVerify,
  },
  proteus_grade: {
    name: 'proteus_grade',
    description: '评分模拟。按契约 rubric 与当前 attempt 证据预测得分，返回 GradePrediction（步骤分、答案分、扣分、置信度）。这是预测不是权威；规则分是 canonical。',
    parameters: GRADE_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    timeoutMs: 30000,
    execute: handleGrade,
  },
  proteus_finalize: {
    name: 'proteus_finalize',
    description: '定稿。校验/重跑当前 attempt 证据（不一致 → EVIDENCE_CONFLICT 且不得 Verified）→ 重算评分与五态 → 写审计包与解答 → 更新考试矩阵（失败即 MATRIX_WRITE_FAILED）→ 账本置 finalized。同解答重复调用幂等，不同解答返回 ALREADY_FINALIZED。',
    parameters: GRADE_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    timeoutMs: 60000,
    execute: handleFinalize,
  },
  proteus_audit: {
    name: 'proteus_audit',
    description: '审计包。write：从账本生成审计包（已有且可 verify 则不覆盖）；verify：结构+语义校验（重跑 evidence、重算 grade 与五态）；replay：按 bundle.verification.plan/seed 重跑并比对 evidence/grade/state。',
    parameters: AUDIT_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    timeoutMs: 60000,
    execute: handleAudit,
  },
};

const ROLE_PROMPT = {
  full: '你按 contract → route → budget start → solve/verify → grade → finalize → audit verify 的顺序推进；finalize 的五态是最终结论。',
  contract: '你只负责建立/校验考试契约，不写解法。歧义用 ask_user_question 问人；大纲外直接标 OutOfSyllabus；契约不合格就停下说明问题。',
  solver: '你只解已契约化的题。步骤必须结构化（id/text/tags/evidence_refs），必须调用 proteus_verify run；Evidence 只能来自 verify，禁止伪造 evidence_id；不做评分。',
  grader: '你只读契约、解答与账本证据，按 rubric 输出 GradePrediction；heuristic 陷阱不扣分；不改写解答。',
  auditor: '你只做 proteus_audit 的 write/verify/replay 与矩阵统计；检查证据链与评分一致性；不改解答；输出问题清单。',
};

const ROLE_TOOLS_TEXT = {
  full: 'proteus_contract(create/validate/show)、proteus_route、proteus_budget、proteus_verify(plan/run)、proteus_grade、proteus_finalize、proteus_audit',
  contract: 'proteus_contract(create/validate/show)、proteus_route(lookup)、proteus_budget',
  solver: 'proteus_contract(show)、proteus_route(lookup)、proteus_budget、proteus_verify(plan/run)',
  grader: 'proteus_contract(show)、proteus_route(lookup)、proteus_budget(status)、proteus_grade',
  auditor: 'proteus_contract(show)、proteus_route(stats)、proteus_budget(status)、proteus_audit(write/verify/replay)',
};

export function buildPromptSection(role) {
  return [
    '## Proteus 工具（应试契约 / 证据 / 评分）',
    '',
    `当前角色：${role}。可用：${ROLE_TOOLS_TEXT[role] ?? ROLE_TOOLS_TEXT.full}`,
    '',
    '- 铁律：先 `proteus_contract create` 拿 contract_id；歧义先澄清，大纲外直接标记，不要猜。',
    '- 状态只有五态：Verified | LowConfidence | Unknown | Ambiguous | OutOfSyllabus。不会就诚实标 Unknown，禁止伪造答案或证据。',
    '- Evidence 只能由 `proteus_verify` 写入；答案要 Verified，至少需要 2 种独立证据（numeric/symbolic/formal/human）pass，且无未消解 major/blocker 规则陷阱；证明题还必须有 formal/human 证据。',
    '- 评分是预测不是权威：规则分是 canonical，`proteus_grade` 只做解释与优化步骤分。',
    '- 预算每个契约只能起表一次；剩余 ≤10% 时只输出已有证据的最佳答案并标低置信。',
    '- 所有状态落盘在 `<工作区>/proteus/`，重启后继续用 contract_id 读取，不要重复建契约。',
    '- 收尾：`proteus_finalize` 给出最终五态与得分，`proteus_audit verify` 自检审计包（会重跑证据、重算 grade 与状态）。',
    '',
    ROLE_PROMPT[role] ?? ROLE_PROMPT.full,
  ].join('\n');
}

/**
 * 挂载 scoped 工具与提示区块。
 * @param {object} ctx 预设作用域上下文
 * @param {object} [config] {role, root, evidenceMinKinds, targetAttempts}
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const role = cfg.role;
  const allowedTools = ROLE_ACTIONS[role] ?? {};
  for (const toolName of TOOL_NAMES) {
    if (!Array.isArray(allowedTools[toolName]) || allowedTools[toolName].length === 0) continue;
    const template = TOOL_DEFINITIONS[toolName];
    const definition = {
      name: template.name,
      description: template.description,
      parameters: template.parameters,
      output: template.output,
      timeoutMs: template.timeoutMs,
      async execute(args, exec) {
        try {
          return await template.execute(args ?? {}, exec ?? {}, { role, cfg, logger: ctx.logger });
        } catch (error) {
          return {
            ok: false,
            error: {
              code: error?.code ?? 'INTERNAL',
              message: error?.message ?? String(error),
            },
          };
        }
      },
    };
    ctx.effect(() => ctx.tools.register(definition), `proteus: register tool ${toolName}`);
  }
  const prompt = buildPromptSection(role);
  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'plugin:proteus-tools', order: 150, text: prompt }),
    'proteus: system prompt section',
  );
}
