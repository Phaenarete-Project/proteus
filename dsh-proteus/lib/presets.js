/**
 * 宿主半侧：按随包 `presets/roster.json` + `presets/persona-*.md` 程序化注册 5 个预设。
 *
 * 行模板固定在这里（顺序稳定），bundle-smith 不必重复写插件清单。
 * 依赖软失败：roster 缺失 / 单个 persona 缺失 / 单个 register 失败都只记日志，
 * 不影响其他预设与宿主启动。
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const PRESETS_SCHEMA = 'proteus.presets/v1';
export const TOOLS_PACKAGE = 'dsh-proteus/tools';

const PERSONA_PLUGIN = '@deepseek-ai/dsh-persona';
const AGENT_INSTRUCTIONS_PLUGIN = '@deepseek-ai/dsh-agent-instructions';

/** 压缩组（与 DSH standard 预设一致：组行 + 3 个插件行）。 */
export function buildCompactionGroup() {
  return {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      },
    ],
  };
}

/** 委派组（spec §7.1 固定 3 行）。 */
export function buildDelegationGroup() {
  return {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent' },
      },
    ],
  };
}

function normalizeRosterEntry(raw) {
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : String(raw.id),
    description: typeof raw.description === 'string' ? raw.description : '',
    order: Number.isFinite(raw.order) ? raw.order : undefined,
    personaFile: typeof raw.personaFile === 'string' ? raw.personaFile : null,
    toolsRole: typeof raw.toolsRole === 'string' ? raw.toolsRole : 'full',
    bash: raw.bash === true,
    jobs: raw.jobs === true,
    delegation: raw.delegation === true,
    askUser: raw.askUser === true,
    web: raw.web === true,
  };
}

/**
 * 读 roster；文件缺失/损坏返回空 roster（宿主启动不依赖它）。
 * @param {string} sourceRoot 包根目录
 */
export function loadRoster(sourceRoot) {
  const path = join(sourceRoot, 'presets', 'roster.json');
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { schema: PRESETS_SCHEMA, presets: [] };
  }
  const presets = Array.isArray(raw?.presets)
    ? raw.presets.filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
    : [];
  return {
    schema: typeof raw?.schema === 'string' ? raw.schema : PRESETS_SCHEMA,
    presets: presets.map(normalizeRosterEntry),
  };
}

/**
 * 读 persona 正文；文件缺失返回 null（调用方跳过该预设并 warn）。
 * 只接受 presets/ 目录内的文件名，拒绝路径穿越。
 * @param {string} sourceRoot
 * @param {string|null} file
 * @returns {string|null}
 */
export function loadPersona(sourceRoot, file) {
  if (typeof file !== 'string' || file.trim() === '') return null;
  const name = basename(file);
  if (name !== file || file.includes('..')) return null;
  try {
    return readFileSync(join(sourceRoot, 'presets', name), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 生成 PresetDefinition。行模板顺序固定，bundle-smith 不重复写。
 * @param {object} rosterEntry
 * @param {string} persona 正文
 * @param {{toolsConfig?: object}} [options]
 * @returns {{id: string, name: string, description: string, order?: number, plugins: object[]}}
 */
export function buildPresetDefinition(rosterEntry, persona, { toolsConfig } = {}) {
  if (!rosterEntry || typeof rosterEntry.id !== 'string' || rosterEntry.id === '') {
    throw new TypeError('buildPresetDefinition 需要带 id 的 roster 条目');
  }
  if (typeof persona !== 'string' || persona.trim() === '') {
    throw new TypeError(`预设 ${rosterEntry.id} 的 persona 为空`);
  }
  const role = typeof rosterEntry.toolsRole === 'string' && rosterEntry.toolsRole !== '' ? rosterEntry.toolsRole : 'full';
  const toolsRowConfig = {
    root: 'proteus',
    ...(toolsConfig && typeof toolsConfig === 'object' ? toolsConfig : {}),
    role,
  };
  const plugins = [
    { id: 'persona', name: PERSONA_PLUGIN, config: { prefix: persona } },
    { id: 'agent-instructions', name: AGENT_INSTRUCTIONS_PLUGIN, config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'proteus-tools', name: TOOLS_PACKAGE, config: toolsRowConfig },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  ];
  if (rosterEntry.bash) plugins.push({ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' });
  if (rosterEntry.jobs) plugins.push({ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' });
  if (rosterEntry.askUser) plugins.push({ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' });
  if (rosterEntry.web) {
    plugins.push({
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: { fetch: false, searchTimeoutMs: 60000 },
    });
  }
  if (rosterEntry.delegation) plugins.push(buildDelegationGroup());
  plugins.push(buildCompactionGroup());

  const definition = {
    id: rosterEntry.id,
    name: rosterEntry.name ?? rosterEntry.id,
    description: rosterEntry.description ?? '',
    plugins,
  };
  if (Number.isFinite(rosterEntry.order)) definition.order = rosterEntry.order;
  return definition;
}

/**
 * 注册全部预设。返回 disposer（可重复调用；注册竞态由 cancelled 标志处理）。
 * @param {{ctx: object, sourceRoot: string, logger?: object, toolsConfig?: object}} input
 * @returns {() => void}
 */
export function registerPresets({ ctx, sourceRoot, logger, toolsConfig } = {}) {
  const disposers = [];
  let cancelled = false;
  const register = ctx?.agentPresets?.register;
  if (typeof register !== 'function') {
    logger?.warn?.('[proteus] agentPresets 服务不可用，跳过预设注册');
    return () => {};
  }

  const roster = loadRoster(sourceRoot);
  if (roster.presets.length === 0) {
    logger?.warn?.(`[proteus] 未找到可用预设（roster 为空或缺失）: ${join(sourceRoot, 'presets', 'roster.json')}`);
    return () => {};
  }

  for (const entry of roster.presets) {
    const persona = loadPersona(sourceRoot, entry.personaFile);
    if (persona === null || persona.trim() === '') {
      logger?.warn?.(`[proteus] 跳过预设 ${entry.id}：缺少 persona ${entry.personaFile ?? '(未声明)'}`);
      continue;
    }
    let definition;
    try {
      definition = buildPresetDefinition(entry, persona, { toolsConfig });
    } catch (error) {
      logger?.warn?.(`[proteus] 预设 ${entry.id} 定义生成失败: ${error?.message ?? error}`);
      continue;
    }
    let pending;
    try {
      pending = Promise.resolve(register.call(ctx.agentPresets, definition));
    } catch (error) {
      logger?.warn?.(`[proteus] 预设 ${entry.id} 注册调用失败: ${error?.message ?? error}`);
      continue;
    }
    pending.then((dispose) => {
      if (typeof dispose !== 'function') return;
      if (cancelled) {
        try {
          const result = dispose();
          if (result && typeof result.then === 'function') result.catch(() => {});
        } catch {
          /* 注销失败不影响宿主 */
        }
        return;
      }
      disposers.push(dispose);
    }).catch((error) => {
      logger?.warn?.(`[proteus] 预设 ${entry.id} 注册失败: ${error?.message ?? error}`);
    });
  }

  return () => {
    if (cancelled) return;
    cancelled = true;
    const owned = disposers.splice(0);
    for (const dispose of owned) {
      try {
        const result = dispose();
        if (result && typeof result.then === 'function') result.catch(() => {});
      } catch {
        /* ignore */
      }
    }
  };
}
