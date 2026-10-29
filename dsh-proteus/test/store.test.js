import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  appendTimeline,
  auditPath,
  contractHex,
  createLedger,
  ledgerPath,
  readJson,
  readJsonStrict,
  readLedger,
  resolveRoot,
  solutionPath,
  toIsoString,
  writeJsonAtomic,
  writeLedger,
} from '../lib/store.js';
import { digest } from '../lib/canonical.js';
import { validateContract } from '../lib/contract.js';
import { makeContract, makeTempDir } from './helpers.js';

test('store：resolveRoot 相对/绝对与默认值', () => {
  assert.equal(resolveRoot('/tmp/ws', 'proteus'), '/tmp/ws/proteus');
  assert.equal(resolveRoot('/tmp/ws', 'proteus'), isAbsolute('/tmp/ws/proteus') ? resolveRoot('/tmp/ws', 'proteus') : '');
  assert.ok(isAbsolute(resolveRoot(undefined, 'proteus')));
  assert.equal(resolveRoot('/tmp/ws', '/abs/path'), '/abs/path');
  assert.equal(resolveRoot('/tmp/ws', ''), '/tmp/ws/proteus');
});

test('store：路径派生与 contractHex 消毒', () => {
  assert.equal(contractHex('sha256:abc'), 'abc');
  assert.equal(contractHex('sha256:../../etc/passwd'), 'etcpasswd');
  assert.equal(contractHex(undefined), 'unknown');
  assert.equal(ledgerPath('/r', 'sha256:abc'), '/r/ledger/abc.json');
  assert.equal(auditPath('/r', 'sha256:abc'), '/r/audit/abc.json');
  assert.equal(solutionPath('/r', 'sha256:abc'), '/r/solutions/abc.md');
});

test('store：原子写 JSON 与通用读取', () => {
  const temp = makeTempDir();
  try {
    const path = join(temp.dir, 'nested', 'a.json');
    writeJsonAtomic(path, { b: 1, a: 2 });
    assert.ok(existsSync(path));
    assert.equal(existsSync(`${path}.tmp`), false);
    assert.deepEqual(readJson(path), { b: 1, a: 2 });
    assert.equal(readJson(join(temp.dir, 'missing.json'), 'fallback'), 'fallback');
    writeFileSync(path, '{corrupt');
    assert.equal(readJson(path, null), null);
    assert.throws(() => readJsonStrict(path), (error) => error.code === 'JSON_CORRUPT');
    assert.equal(readJsonStrict(join(temp.dir, 'missing.json')), null);
  } finally {
    temp.cleanup();
  }
});

test('store：ledger 读写、缺失 null、损坏抛错且不覆盖', () => {
  const temp = makeTempDir();
  try {
    const contract = validateContract(makeContract()).contract;
    assert.equal(readLedger(temp.dir, contract.contract_id), null);
    const ledger = createLedger(contract);
    appendTimeline(ledger, 'contract.created', '2026-01-01T00:00:00.000Z');
    const path = writeLedger(temp.dir, ledger);
    const loaded = readLedger(temp.dir, contract.contract_id);
    assert.equal(loaded.schema, 'proteus.ledger/v1');
    assert.equal(loaded.contract.contract_id, contract.contract_id);
    assert.equal(loaded.timeline.length, 1);

    writeFileSync(path, '{broken');
    assert.throws(() => readLedger(temp.dir, contract.contract_id), (error) => error.code === 'LEDGER_CORRUPT');
    // 文件仍保留损坏内容，没有被静默覆盖
    assert.equal(readJson(path, null), null);
    assert.equal(readFileSync(path, 'utf8'), '{broken');
  } finally {
    temp.cleanup();
  }
});

test('store：schema 不符视为损坏', () => {
  const temp = makeTempDir();
  try {
    const contract = validateContract(makeContract()).contract;
    const path = ledgerPath(temp.dir, contract.contract_id);
    mkdirSync(join(temp.dir, 'ledger'), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema: 'other', contract }));
    assert.throws(() => readLedger(temp.dir, contract.contract_id), (error) => error.code === 'LEDGER_CORRUPT');
  } finally {
    temp.cleanup();
  }
});

test('store：timeline 哈希链可由 seq/at/event/prev 复算', () => {
  const contract = validateContract(makeContract()).contract;
  const ledger = createLedger(contract);
  const first = appendTimeline(ledger, 'contract.created', '2026-01-01T00:00:00.000Z');
  const second = appendTimeline(ledger, 'evidence.appended', '2026-01-01T00:01:00.000Z');
  assert.equal(first.seq, 1);
  assert.equal(first.prev, null);
  assert.equal(first.hash, digest({ seq: 1, at: '2026-01-01T00:00:00.000Z', event: 'contract.created', prev: null }));
  assert.equal(second.seq, 2);
  assert.equal(second.prev, first.hash);
  assert.equal(second.hash, digest({ seq: 2, at: '2026-01-01T00:01:00.000Z', event: 'evidence.appended', prev: first.hash }));
});

test('store：toIsoString 归一化', () => {
  assert.equal(toIsoString('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(toIsoString(new Date('2026-01-01T00:00:00.000Z')), '2026-01-01T00:00:00.000Z');
  assert.match(toIsoString('not-a-date'), /^\d{4}-\d{2}-\d{2}T/);
});
