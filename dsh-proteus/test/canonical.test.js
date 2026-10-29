import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, digest, roundHalf, sha256Hex, roundTo } from '../lib/canonical.js';

test('canonicalJson：键排序、无空白、嵌套稳定', () => {
  const a = canonicalJson({ b: 1, a: { d: [3, 2], c: 'x' } });
  const b = canonicalJson({ a: { c: 'x', d: [3, 2] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":"x","d":[3,2]},"b":1}');
  assert.equal(canonicalJson([1, { z: true, a: null }]), '[1,{"a":null,"z":true}]');
});

test('canonicalJson：数字与缺失值规范化', () => {
  assert.equal(canonicalJson(-0), '0');
  assert.equal(canonicalJson(NaN), 'null');
  assert.equal(canonicalJson(Infinity), 'null');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([undefined, () => 1]), '[null,null]');
  assert.equal(canonicalJson(1.5), '1.5');
});

test('digest / sha256Hex：稳定且带算法前缀', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(digest('abc'), `sha256:${sha256Hex('abc')}`);
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
});

test('roundHalf：0.5 网格、浮点误差与 -0', () => {
  assert.equal(roundHalf(9.5), 9.5);
  assert.equal(roundHalf(9.25), 9.5);
  assert.equal(roundHalf(9.24), 9);
  assert.equal(roundHalf(9.249999999999998), 9.5);
  assert.equal(roundHalf(-0.25), -0.5);
  assert.equal(Object.is(roundHalf(0), -0), false);
  assert.equal(roundHalf(NaN), 0);
});

test('roundTo：保留两位小数', () => {
  assert.equal(roundTo(0.7166666, 2), 0.72);
  assert.equal(roundTo(0.5, 2), 0.5);
  assert.equal(roundTo(NaN, 2), 0);
});
