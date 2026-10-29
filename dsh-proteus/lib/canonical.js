/**
 * 规范化 JSON 与哈希工具。
 *
 * 契约、证据、审计包的所有哈希都建立在 canonicalJson 上：对象键排序、
 * 无空白、数字规范化。纯 JSON（undefined/函数不参与），时间统一 ISO-8601 UTC。
 */

import { createHash } from 'node:crypto';

/**
 * 稳定序列化：对象键按字典序递归排序，数组保持顺序，无多余空白。
 * - `undefined` / 函数 / symbol：对象里省略，数组里写成 null（与 JSON 一致）
 * - `NaN` / `Infinity`：写成 null（JSON 语义）
 * - `-0`：写成 0
 * - 带 toJSON 的对象（如 Date）：按 toJSON 结果处理
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return stringify(value, 0);
}

function stringify(value, depth) {
  if (depth > 64) throw new TypeError('canonicalJson: 嵌套过深');
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) return 'null';
    if (Object.is(value, -0)) return '0';
    return JSON.stringify(value);
  }
  if (type === 'bigint') return JSON.stringify(value.toString());
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null';
  if (Array.isArray(value)) {
    const items = value.map((item) => stringify(item, depth + 1));
    return `[${items.join(',')}]`;
  }
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return stringify(value.toJSON(), depth + 1);
    const keys = Object.keys(value).filter((key) => {
      const item = value[key];
      const t = typeof item;
      return t !== 'undefined' && t !== 'function' && t !== 'symbol';
    });
    keys.sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${stringify(value[key], depth + 1)}`);
    return `{${body.join(',')}}`;
  }
  return 'null';
}

/**
 * UTF-8 文本的 sha256 小写 hex。
 * @param {string} text
 * @returns {string}
 */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 取摘要：字符串按原文哈希，其余按 canonicalJson 哈希。
 * @param {unknown} valueOrString
 * @returns {string} `sha256:<hex>`
 */
export function digest(valueOrString) {
  const text = typeof valueOrString === 'string' ? valueOrString : canonicalJson(valueOrString);
  return `sha256:${sha256Hex(text)}`;
}

/**
 * 四舍五入到 0.5 的整数倍，并把 -0 归一为 0。
 * 用 1e-9 容差吸收浮点累加误差（如 9.249999999999998）。
 * @param {number} n
 * @returns {number}
 */
export function roundHalf(n) {
  if (!Number.isFinite(n)) return 0;
  const scaled = n * 2;
  const epsilon = 1e-9;
  const rounded = Math.round(scaled + (scaled >= 0 ? epsilon : -epsilon));
  const out = rounded / 2;
  return Object.is(out, -0) ? 0 : out;
}

/** 把数字收敛到 [min,max]；非有限值返回 min。 */
export function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 保留 digits 位小数（默认 2），用于 confidence 等展示字段。 */
export function roundTo(n, digits = 2) {
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  const out = Math.round((n + Number.EPSILON) * factor) / factor;
  return Object.is(out, -0) ? 0 : out;
}
