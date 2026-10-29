/**
 * 包根入口（宿主半侧）`dsh-proteus`。
 *
 * 只做两件事：
 * 1. 把随包 `skills/proteus/` 幂等同步到 `$DSH_HOME/skills/proteus/`，让技能可被发现；
 * 2. `agentPresets` 服务可用时，按 `presets/roster.json` + persona 正文程序化注册 5 个预设。
 *
 * 两者都是软失败：出错只记日志，不阻断宿主启动。`agentPresets` 用 ctx.inject 软依赖。
 */

import { fileURLToPath } from 'node:url';
import { defineConfig, withDefaults } from './config.js';
import { registerPresets } from './presets.js';
import { resolveDshHome, syncSkills } from './skills.js';

export const name = 'proteus';

export const Config = defineConfig((z) => z.object({
  enabled: z.boolean().default(true),
  skillSync: z.boolean().default(true),
  presets: z.boolean().default(true),
}));

export const inject = [];

export const PLUGIN_VERSION = '0.1.0';

function makeLogger(ctx) {
  const sink = ctx?.logger;
  const forward = (level, message) => {
    try {
      if (typeof sink === 'function') sink(level, message);
      else if (sink && typeof sink[level] === 'function') sink[level](message);
      else if (sink && typeof sink.log === 'function') sink.log(message);
    } catch {
      /* 日志失败不影响插件 */
    }
  };
  return {
    info: (message) => forward('info', message),
    warn: (message) => forward('warn', message),
  };
}

/**
 * 宿主插件入口。
 * @param {object} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const cfg = withDefaults(config, { enabled: true, skillSync: true, presets: true });
  if (cfg.enabled === false) return;
  const logger = makeLogger(ctx);
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const dshHome = resolveDshHome();

  if (cfg.skillSync !== false) {
    ctx.effect(() => {
      try {
        const result = syncSkills({ sourceRoot, dshHome, logger });
        logger.info(`[proteus] 技能同步：synced=${result.synced} current=${result.current} failed=${result.failed.length}`);
      } catch (error) {
        logger.warn(`[proteus] 技能同步异常: ${error?.message ?? error}`);
      }
      return () => {};
    }, 'proteus: skill sync');
  }

  if (cfg.presets !== false) {
    ctx.effect(() => {
      let disposePresets = null;
      let injectDisposer = null;
      let cancelled = false;
      if (typeof ctx.inject === 'function') {
        injectDisposer = ctx.inject(['agentPresets'], (scoped) => {
          if (cancelled) return;
          try {
            disposePresets = registerPresets({ ctx: scoped, sourceRoot, logger });
          } catch (error) {
            logger.warn(`[proteus] 预设注册异常: ${error?.message ?? error}`);
          }
        });
      } else {
        logger.warn('[proteus] 当前上下文没有 ctx.inject，跳过预设注册');
      }
      return () => {
        cancelled = true;
        try {
          const result = injectDisposer?.();
          if (result && typeof result.then === 'function') result.catch(() => {});
        } catch {
          /* ignore */
        }
        try {
          const result = disposePresets?.();
          if (result && typeof result.then === 'function') result.catch(() => {});
        } catch {
          /* ignore */
        }
      };
    }, 'proteus: presets');
  }
}
