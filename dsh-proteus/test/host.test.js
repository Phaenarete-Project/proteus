import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, resolveDshHome, syncSkills } from '../lib/skills.js';
import {
  buildCompactionGroup,
  buildDelegationGroup,
  buildPresetDefinition,
  loadPersona,
  loadRoster,
  registerPresets,
  TOOLS_PACKAGE,
} from '../lib/presets.js';
import { apply as hostApply, Config, inject, name } from '../lib/index.js';
import { makeHostCtx, makeTempDir } from './helpers.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function writeFixture(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

test('skills：首次同步写入、第二次全部 current（幂等）', () => {
  const source = makeTempDir('proteus-src-');
  const home = makeTempDir('proteus-home-');
  try {
    writeFixture(source.dir, {
      'skills/proteus/SKILL.md': '---\nname: proteus\ndescription: fixture\n---\n# Proteus\n',
      'skills/proteus/大纲/高考数学.md': 'GK.FUNC.DERIV\n',
    });
    const logs = [];
    const logger = { info: (message) => logs.push(message), warn: (message) => logs.push(message) };
    const first = syncSkills({ sourceRoot: source.dir, dshHome: home.dir, logger });
    assert.deepEqual({ synced: first.synced, current: first.current, failed: first.failed.length }, { synced: 2, current: 0, failed: 0 });
    assert.equal(readFileSync(join(home.dir, 'skills/proteus/SKILL.md'), 'utf8'), '---\nname: proteus\ndescription: fixture\n---\n# Proteus\n');
    const second = syncSkills({ sourceRoot: source.dir, dshHome: home.dir, logger });
    assert.deepEqual({ synced: second.synced, current: second.current, failed: second.failed.length }, { synced: 0, current: 2, failed: 0 });
    writeFileSync(join(source.dir, 'skills/proteus/SKILL.md'), '---\nname: proteus\ndescription: fixture-v2\n---\n# Proteus v2\n');
    const third = syncSkills({ sourceRoot: source.dir, dshHome: home.dir, logger });
    assert.deepEqual({ synced: third.synced, current: third.current }, { synced: 1, current: 1 });
    assert.equal(readFileSync(join(home.dir, 'skills/proteus/SKILL.md'), 'utf8'), '---\nname: proteus\ndescription: fixture-v2\n---\n# Proteus v2\n');
    assert.equal(logs.length >= 3, true);
  } finally {
    source.cleanup();
    home.cleanup();
  }
});

test('skills：源目录缺失只记 failed 不抛错', () => {
  const home = makeTempDir('proteus-home-');
  try {
    const result = syncSkills({ sourceRoot: home.dir, dshHome: home.dir });
    assert.equal(result.synced, 0);
    assert.equal(result.current, 0);
    assert.equal(result.failed[0].code, 'SKILL_SOURCE_MISSING');
  } finally {
    home.cleanup();
  }
});

test('skills：DSH_HOME 解析与 ~ 展开', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh' }, '/home/u'), '/custom/dsh');
  assert.equal(resolveDshHome({ DSH_HOME: '~/dsh-home' }, '/home/u'), '/home/u/dsh-home');
  assert.equal(resolveDshHome({}, '/home/u'), '/home/u/.dsh');
  assert.equal(expandHome('~', '/home/u'), '/home/u');
  assert.equal(expandHome('~/x', '/home/u'), '/home/u/x');
  assert.equal(expandHome('/abs', '/home/u'), '/abs');
});

test('presets：loadRoster / loadPersona 读取真实预设清单', () => {
  const roster = loadRoster(PACKAGE_ROOT);
  assert.equal(roster.schema, 'proteus.presets/v1');
  assert.equal(roster.presets.length, 5);
  assert.deepEqual(roster.presets.map((entry) => entry.id), [
    'proteus',
    'proteus-contractor',
    'proteus-solver',
    'proteus-grader',
    'proteus-auditor',
  ]);
  const persona = loadPersona(PACKAGE_ROOT, roster.presets[0].personaFile);
  assert.equal(typeof persona, 'string');
  assert.ok(persona.length > 0);
  assert.equal(loadPersona(PACKAGE_ROOT, 'missing.md'), null);
  assert.equal(loadPersona(PACKAGE_ROOT, '../package.json'), null);
  assert.equal(loadPersona(PACKAGE_ROOT, null), null);
  assert.deepEqual(loadRoster(join(PACKAGE_ROOT, 'does-not-exist')).presets, []);
});

test('presets：行模板固定（persona/工具/委派/压缩/角色开关）', () => {
  const entry = loadRoster(PACKAGE_ROOT).presets[0];
  const definition = buildPresetDefinition(entry, '# persona\n', { toolsConfig: { root: 'proteus' } });
  assert.equal(definition.id, 'proteus');
  assert.equal(definition.order, 10);
  assert.equal(definition.plugins[0].id, 'persona');
  assert.equal(definition.plugins[0].name, '@deepseek-ai/dsh-persona');
  assert.equal(definition.plugins[0].config.prefix, '# persona\n');
  const toolsRow = definition.plugins.find((row) => row.id === 'proteus-tools');
  assert.equal(toolsRow.name, TOOLS_PACKAGE);
  assert.deepEqual(toolsRow.config, { root: 'proteus', role: 'full' });
  const ids = definition.plugins.map((row) => row.id);
  assert.deepEqual(ids, [
    'persona', 'agent-instructions', 'time-context', 'proteus-tools', 'tool-fs',
    'tool-fs-search', 'skill-filesystem', 'tool-skill', 'tool-todo',
    'tool-bash', 'tool-jobs', 'tool-ask-user', 'tool-web', 'delegation', 'compaction',
  ]);
  const delegation = definition.plugins.find((row) => row.id === 'delegation');
  assert.equal(delegation.name, 'cordis:group');
  assert.equal(delegation.group, true);
  assert.deepEqual(delegation.isolate, { workflowEngine: true });
  assert.deepEqual(delegation.config.map((row) => row.id), ['tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent']);
  const compaction = definition.plugins.find((row) => row.id === 'compaction');
  assert.equal(compaction.group, true);
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.map((row) => row.id), ['compaction-basic', 'command-compact', 'tool-result-pruner']);
  assert.deepEqual(compaction.config[2].config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });

  // 精简角色不产生 bash/jobs/askUser/web/delegation 行
  const graderEntry = loadRoster(PACKAGE_ROOT).presets.find((item) => item.id === 'proteus-grader');
  const grader = buildPresetDefinition(graderEntry, '# grader\n', {});
  const graderIds = grader.plugins.map((row) => row.id);
  for (const absent of ['tool-bash', 'tool-jobs', 'tool-ask-user', 'tool-web', 'delegation']) {
    assert.equal(graderIds.includes(absent), false, absent);
  }
  assert.equal(graderIds.includes('compaction'), true);
  assert.deepEqual(buildDelegationGroup().name, 'cordis:group');
  assert.equal(buildCompactionGroup().config.length, 3);
});

test('presets：registerPresets 跳过缺 persona 的条目、异步注册、释放幂等', async () => {
  const source = makeTempDir('proteus-presets-');
  try {
    writeFixture(source.dir, {
      'presets/roster.json': JSON.stringify({
        schema: 'proteus.presets/v1',
        presets: [
          { id: 'p1', name: 'P1', order: 1, personaFile: 'persona-p1.md', toolsRole: 'full' },
          { id: 'p2', name: 'P2', order: 2, personaFile: 'persona-missing.md', toolsRole: 'solver' },
        ],
      }),
      'presets/persona-p1.md': '# P1 persona\n',
    });
    const registered = [];
    const disposed = [];
    const logs = [];
    const ctx = {
      agentPresets: {
        async register(definition) {
          registered.push(definition);
          return async () => { disposed.push(definition.id); };
        },
      },
    };
    const dispose = registerPresets({ ctx, sourceRoot: source.dir, logger: { warn: (message) => logs.push(message) } });
    assert.equal(typeof dispose, 'function');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(registered.map((item) => item.id), ['p1']);
    assert.equal(logs.some((message) => message.includes('persona-missing.md')), true);
    dispose();
    dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(disposed, ['p1']);
  } finally {
    source.cleanup();
  }
});

test('presets：registerPresets 软失败（无服务 / register 异常）', async () => {
  const source = makeTempDir('proteus-presets-');
  try {
    const logs = [];
    const logger = { warn: (message) => logs.push(message) };
    const missingService = registerPresets({ ctx: {}, sourceRoot: source.dir, logger });
    assert.equal(typeof missingService, 'function');
    missingService();
    assert.equal(logs.some((message) => message.includes('agentPresets')), true);

    writeFixture(source.dir, {
      'presets/roster.json': JSON.stringify({
        schema: 'proteus.presets/v1',
        presets: [
          { id: 'bad', personaFile: 'persona-bad.md', toolsRole: 'full' },
          { id: 'good', personaFile: 'persona-good.md', toolsRole: 'full' },
        ],
      }),
      'presets/persona-bad.md': '# bad\n',
      'presets/persona-good.md': '# good\n',
    });
    const registered = [];
    const ctx = {
      agentPresets: {
        async register(definition) {
          if (definition.id === 'bad') throw new Error('boom');
          registered.push(definition.id);
          return async () => {};
        },
      },
    };
    const dispose = registerPresets({ ctx, sourceRoot: source.dir, logger });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(registered, ['good']);
    assert.equal(logs.some((message) => message.includes('boom')), true);
    dispose();
  } finally {
    source.cleanup();
  }
});

test('index：宿主入口同步技能并注册预设', async () => {
  const home = makeTempDir('proteus-dsh-home-');
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home.dir;
    const { ctx, effects, injects, logs } = makeHostCtx();
    hostApply(ctx, {});
    assert.equal(name, 'proteus');
    assert.equal(Config, undefined); // 工作区没有 schemastery
    assert.deepEqual(inject, []);
    assert.equal(effects.length, 2);
    assert.deepEqual(effects.map((item) => item.label), ['proteus: skill sync', 'proteus: presets']);
    assert.equal(existsSync(join(home.dir, 'skills/proteus/SKILL.md')), true);
    assert.equal(injects.length, 1);
    assert.deepEqual(injects[0].services, ['agentPresets']);

    const registered = [];
    const disposed = [];
    const scoped = {
      agentPresets: {
        async register(definition) {
          registered.push(definition.id);
          return async () => { disposed.push(definition.id); };
        },
      },
    };
    injects[0].callback(scoped);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(registered, ['proteus', 'proteus-contractor', 'proteus-solver', 'proteus-grader', 'proteus-auditor']);
    assert.equal(logs.some((entry) => entry.level === 'warn'), false);

    effects[1].dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(disposed.length, 5);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    home.cleanup();
  }
});

test('index：enabled/skillSync/presets 开关', () => {
  const home = makeTempDir('proteus-dsh-home-');
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home.dir;
    const disabled = makeHostCtx();
    hostApply(disabled.ctx, { enabled: false });
    assert.equal(disabled.effects.length, 0);
    assert.equal(disabled.injects.length, 0);

    const noSkills = makeHostCtx();
    hostApply(noSkills.ctx, { skillSync: false });
    assert.equal(noSkills.effects.length, 1);
    assert.equal(existsSync(join(home.dir, 'skills')), false);

    const noPresets = makeHostCtx();
    hostApply(noPresets.ctx, { presets: false });
    assert.equal(noPresets.effects.length, 1);
    assert.equal(noPresets.injects.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    home.cleanup();
  }
});
