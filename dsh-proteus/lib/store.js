/**
 * 工作区存储层：路径解析、原子写、ledger 读写、timeline 哈希链。
 *
 * 约定：
 * - 读缺失 → null；读损坏 → 抛带 code 的错误（不静默覆盖、不丢数据）。
 * - 所有写盘先写 `<path>.tmp` 再 rename。
 * - 路径解析：`<cwd>/<root>`，root 默认 `proteus`；root 为绝对路径时直接使用。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { digest } from './canonical.js';

export const LEDGER_SCHEMA = 'proteus.ledger/v1';

/** 构造带错误码的 Error。 */
export function codedError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

/** 统一时间表示：Date/字符串/毫秒 → ISO-8601 UTC。 */
export function toIsoString(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

/**
 * 解析工作区根目录。
 * @param {string|undefined} cwd 会话工作区（缺省 process.cwd()）
 * @param {string|undefined} root 相对或绝对 root（缺省 'proteus'）
 * @returns {string} 绝对路径
 */
export function resolveRoot(cwd, root) {
  const base = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd();
  const name = typeof root === 'string' && root.trim() !== '' ? root : 'proteus';
  return isAbsolute(name) ? name : join(base, name);
}

/** contract_id → 文件名用的 hex（去掉算法前缀并做最小字符消毒）。 */
export function contractHex(contractId) {
  const raw = String(contractId ?? '').replace(/^sha256:/, '');
  return raw.replace(/[^0-9a-zA-Z_-]/g, '') || 'unknown';
}

export function ledgerPath(rootDir, contractId) {
  return join(rootDir, 'ledger', `${contractHex(contractId)}.json`);
}

export function auditPath(rootDir, contractId) {
  return join(rootDir, 'audit', `${contractHex(contractId)}.json`);
}

export function solutionPath(rootDir, contractId) {
  return join(rootDir, 'solutions', `${contractHex(contractId)}.md`);
}

export function matrixPath(rootDir) {
  return join(rootDir, 'matrix.json');
}

/**
 * 读 JSON；缺失或解析失败返回 fallback（通用读取，不做损坏检测）。
 * 需要区分损坏时请用 readJsonStrict / readLedger。
 */
export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 严格读 JSON：缺失返回 null，解析失败抛 JSON_CORRUPT。
 * @param {string} path
 */
export function readJsonStrict(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw codedError('READ_FAILED', `读取失败 ${path}: ${error?.message ?? error}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw codedError('JSON_CORRUPT', `JSON 损坏 ${path}: ${error?.message ?? error}`);
  }
}

/** 原子写 JSON：先写 .tmp 再 rename；目录自动创建。 */
export function writeJsonAtomic(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 原子写文本。 */
export function writeTextAtomic(path, text) {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    throw codedError('WRITE_FAILED', `写入失败 ${path}: ${error?.message ?? error}`);
  }
}

/**
 * 读 ledger。
 * @param {string} rootDir 已解析的根目录
 * @param {string} contractId
 * @returns {object|null} 缺失返回 null；损坏抛 LEDGER_CORRUPT
 */
export function readLedger(rootDir, contractId) {
  const path = ledgerPath(rootDir, contractId);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw codedError('LEDGER_CORRUPT', `读取 ledger 失败 ${path}: ${error?.message ?? error}`);
  }
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch (error) {
    throw codedError('LEDGER_CORRUPT', `ledger JSON 损坏 ${path}: ${error?.message ?? error}`);
  }
  if (!ledger || typeof ledger !== 'object' || !ledger.contract || typeof ledger.contract !== 'object') {
    throw codedError('LEDGER_CORRUPT', `ledger 结构不完整 ${path}`);
  }
  if (ledger.schema !== LEDGER_SCHEMA) {
    throw codedError('LEDGER_CORRUPT', `ledger schema 不符 ${path}: ${ledger.schema}`);
  }
  return ledger;
}

/** 写 ledger（路径由 ledger.contract.contract_id 推导）。 */
export function writeLedger(rootDir, ledger) {
  if (!ledger || !ledger.contract || typeof ledger.contract.contract_id !== 'string') {
    throw codedError('LEDGER_INVALID', 'writeLedger 需要带 contract.contract_id 的 ledger');
  }
  const path = ledgerPath(rootDir, ledger.contract.contract_id);
  writeJsonAtomic(path, ledger);
  return path;
}

/**
 * 向 ledger 追加一条哈希链时间线事件。
 * hash = digest({seq, at, event, prev})，verifyBundle 会逐条重算。
 * @returns {object} 新的事件条目
 */
export function appendTimeline(ledger, event, at) {
  const atIso = toIsoString(at);
  const timeline = Array.isArray(ledger.timeline) ? ledger.timeline : [];
  const seq = timeline.length + 1;
  const prev = timeline.length > 0 ? timeline[timeline.length - 1].hash ?? null : null;
  const entry = { seq, at: atIso, event: String(event), prev, hash: digest({ seq, at: atIso, event: String(event), prev }) };
  ledger.timeline = [...timeline, entry];
  return entry;
}

/** 新建空 ledger。 */
export function createLedger(contract) {
  return {
    schema: LEDGER_SCHEMA,
    contract,
    state: 'created',
    budget: null,
    verification: null,
    evidence: [],
    grade: null,
    final: null,
    timeline: [],
  };
}

/**
 * 当前 attempt 的证据（M1）。
 * ledger.verification.evidence_ids 存在时只取这些 id；没有 verification 时回退全量。
 * @param {object} ledger
 * @returns {object[]}
 */
export function currentEvidence(ledger) {
  const all = Array.isArray(ledger?.evidence) ? ledger.evidence.filter((item) => item && typeof item === 'object') : [];
  const ids = ledger?.verification?.evidence_ids;
  if (!Array.isArray(ids)) return all;
  const wanted = new Set(ids);
  return all.filter((item) => wanted.has(item.evidence_id));
}
