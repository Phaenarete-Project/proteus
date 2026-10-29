/**
 * Config 依赖的可选加载层。
 *
 * 工作区没有 node_modules，`schemastery` 只在 DSH 运行时里可用。
 * 因此这里用动态 import + 失败回退：拿不到时所有插件导出的 `Config` 为
 * `undefined`（DSH 允许没有 Config 的插件），拿到时正常构造 schema。
 *
 * 禁止在其它模块顶层裸写 `import ... from 'schemastery'`。
 */

let loaded = null;
try {
  const mod = await import('schemastery');
  const candidate = mod?.default ?? mod ?? null;
  if (candidate && typeof candidate.object === 'function') loaded = candidate;
} catch {
  loaded = null;
}

/** schemastery 的默认导出（不可用时为 null）。 */
export const z = loaded;

/** 当前环境是否加载到了 schemastery。 */
export function hasSchemaLib() {
  return loaded !== null;
}

/**
 * 按 DSH 约定构造 Config：`z.object(shape)`，不可用时返回 undefined。
 * @param {object} shape 形如 `{ role: z.string() }` 的字段表
 */
export function configSchema(shape) {
  if (!loaded) return undefined;
  try {
    return loaded.object(shape);
  } catch {
    return undefined;
  }
}

/**
 * 用 z 工厂懒构造 Config：仅在 schemastery 可用时执行 factory。
 * @param {(z: any) => any} factory
 */
export function defineConfig(factory) {
  if (!loaded) return undefined;
  try {
    return factory(loaded);
  } catch {
    return undefined;
  }
}

/**
 * 合并配置默认值。Config 为 undefined 时 DSH 不会注入配置，工具侧仍然需要
 * 稳定的默认值，所以每个插件都调用这里补默认。
 * @param {unknown} value
 * @param {Record<string, unknown>} defaults
 */
export function withDefaults(value, defaults) {
  const out = { ...defaults };
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = item;
    }
  }
  return out;
}
