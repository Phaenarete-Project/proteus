import test from 'node:test';
import assert from 'node:assert/strict';
import { evalNumeric, normalizeExpression, parseEquation, sameValue, toFiniteNumber } from '../lib/expr.js';

test('expr：四则运算优先级与括号', () => {
  assert.equal(evalNumeric('1+2*3'), 7);
  assert.equal(evalNumeric('(1+2)*3'), 9);
  assert.equal(evalNumeric('8/2/2'), 2);
  assert.equal(evalNumeric('-2^2'), -4);
  assert.equal(evalNumeric('2^3^2'), 512);
  assert.equal(evalNumeric('2^-1'), 0.5);
});

test('expr：幂、隐式乘法与函数', () => {
  assert.equal(evalNumeric('2x^2', { x: 3 }), 18);
  assert.equal(evalNumeric('3(x+1)', { x: 2 }), 9);
  assert.equal(evalNumeric('x(x+1)', { x: 2 }), 6);
  assert.equal(evalNumeric('sqrt(9)+abs(-2)'), 5);
  assert.equal(evalNumeric('sin(pi/2)'), 1);
  assert.equal(evalNumeric('max(1, 3, 2)'), 3);
  assert.equal(evalNumeric('|(-3)|'), 3);
});

test('expr：LaTeX 归一化', () => {
  assert.equal(normalizeExpression('2\\cdot 3').replace(/\s+/g, ''), '2*3');
  assert.equal(evalNumeric('2\\cdot 3'), 6);
  assert.equal(evalNumeric('\\frac{1}{2} + \\frac{1}{2}'), 1);
  assert.equal(evalNumeric('x^{2}', { x: 4 }), 16);
  assert.equal(evalNumeric('\\sqrt{16}'), 4);
  assert.equal(evalNumeric('2\\pi', {}), Math.PI * 2);
});

test('expr：非法表达式抛错', () => {
  assert.throws(() => evalNumeric('1+'), /意外结束|期望/);
  assert.throws(() => evalNumeric('foo(1)'), /未知函数/);
  assert.throws(() => evalNumeric('x+1'), /未定义变量/);
  assert.throws(() => evalNumeric('1 $ 2'), /非法字符/);
  assert.throws(() => evalNumeric(''), /表达式为空/);
});

test('expr：parseEquation 与 sameValue', () => {
  assert.deepEqual(parseEquation('x^2 - 5*x + 6 = 0'), { lhs: 'x^2 - 5*x + 6', rhs: '0' });
  assert.deepEqual(parseEquation('3x=6'), { lhs: '3x', rhs: '6' });
  assert.deepEqual(parseEquation('2+3'), { lhs: '2+3', rhs: '0' });
  assert.throws(() => parseEquation('1=2=3'), /只能包含一个/);
  assert.equal(sameValue(1, 1 + 1e-12), true);
  assert.equal(sameValue(1, 1.1), false);
  assert.equal(sameValue(1, 1.0005, { abs: 0.001 }), true);
  assert.equal(sameValue(1000, 1000.5, { rel: 0.001 }), true);
  assert.equal(sameValue(Infinity, Infinity), false);
});

test('expr：toFiniteNumber 只接受纯数字文本', () => {
  assert.equal(toFiniteNumber('2'), 2);
  assert.equal(toFiniteNumber('-0.5'), -0.5);
  assert.equal(toFiniteNumber('1e3'), 1000);
  assert.equal(toFiniteNumber('2x'), null);
  assert.equal(toFiniteNumber(NaN), null);
  assert.equal(toFiniteNumber(''), null);
});
