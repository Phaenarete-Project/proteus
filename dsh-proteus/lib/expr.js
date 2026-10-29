/**
 * 安全表达式解析与数值求值（递归下降，不使用 eval / new Function）。
 *
 * v0.1 只做实数域数值计算：支持 + - * / % ^、括号、绝对值（|x|）、常量
 * pi/e、常用函数，以及隐式乘法（2x、3(x+1)、x(x+1)）。
 * 未知变量或未知函数一律抛错，调用方据此标记证据为 unknown。
 */

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };

/** 支持的函数表（名字小写）。 */
const FUNCTIONS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: (x) => Math.log10(x),
  log2: (x) => Math.log2(x),
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

/** 文本里的标识符集合，供调用方复用（陷阱检测等）。 */
export const FUNCTION_NAMES = Object.freeze(Object.keys(FUNCTIONS));

/**
 * 归一化常见 LaTeX/数学装饰，减少解析失败：
 * `\cdot \times`→`*`，`\div`→`/`，`\pi`→`pi`，`\ln`→`ln`，`\left \right` 去掉，
 * `^{...}`/`{...}`→括号，Unicode 运算符替换。
 * @param {string} text
 * @returns {string}
 */
export function normalizeExpression(text) {
  if (typeof text !== 'string') throw new TypeError('表达式必须是字符串');
  let out = text;
  out = out.replace(/\\left|\\right/g, '');
  out = out.replace(/\\cdot|\\times|×|·/g, '*');
  out = out.replace(/\\div|÷/g, '/');
  out = out.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))');
  out = out.replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt(($1))');
  out = out.replace(/\\pi/g, 'pi');
  out = out.replace(/\\ln/g, 'ln');
  out = out.replace(/\\log/g, 'log');
  out = out.replace(/\\[,;:!]/g, '');
  out = out.replace(/\\ /g, '');
  out = out.replace(/[{}]/g, (ch) => (ch === '{' ? '(' : ')'));
  out = out.replace(/[−–—]/g, '-');
  out = out.replace(/[（]/g, '(').replace(/[）]/g, ')');
  out = out.replace(/[≤≥≠]/g, '');
  out = out.replace(/\*\*/g, '^');
  return out;
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!match) throw new SyntaxError(`非法数字 at ${i}`);
      tokens.push({ type: 'num', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      tokens.push({ type: 'id', value: match[0] });
      i += match[0].length;
      continue;
    }
    if ('+-*/^%(),|'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new SyntaxError(`非法字符 "${ch}" at ${i}`);
  }
  return tokens;
}

class Parser {
  constructor(tokens, vars) {
    this.tokens = tokens;
    this.index = 0;
    this.vars = vars ?? {};
  }

  peek() {
    return this.tokens[this.index] ?? null;
  }

  next() {
    const token = this.tokens[this.index];
    if (!token) throw new SyntaxError('表达式意外结束');
    this.index += 1;
    return token;
  }

  expectOp(value) {
    const token = this.next();
    if (token.type !== 'op' || token.value !== value) {
      throw new SyntaxError(`期望 "${value}"，实际 "${token.value}"`);
    }
  }

  parseExpression() {
    let left = this.parseTerm();
    for (;;) {
      const token = this.peek();
      if (!token || token.type !== 'op' || (token.value !== '+' && token.value !== '-')) break;
      this.next();
      const right = this.parseTerm();
      left = token.value === '+' ? left + right : left - right;
      void PREC;
    }
    return left;
  }

  parseTerm() {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (!token) break;
      if (token.type === 'op' && ['*', '/', '%'].includes(token.value)) {
        this.next();
        const right = this.parseUnary();
        if (token.value === '*') left *= right;
        else if (token.value === '/') left /= right;
        else left %= right;
        continue;
      }
      // 隐式乘法：2x、3(x+1)、x(y)、)( 等；不吞掉 +/- 与右括号。
      if (token.type === 'num' || token.type === 'id' || (token.type === 'op' && token.value === '(')) {
        const right = this.parseUnary();
        left *= right;
        continue;
      }
      break;
    }
    return left;
  }

  parseUnary() {
    const token = this.peek();
    if (token && token.type === 'op' && (token.value === '+' || token.value === '-')) {
      this.next();
      const value = this.parseUnary();
      return token.value === '-' ? -value : value;
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parseAtom();
    const token = this.peek();
    if (token && token.type === 'op' && token.value === '^') {
      this.next();
      const exponent = this.parseUnary(); // 右结合，允许 2^-1
      return base ** exponent;
    }
    return base;
  }

  readVariable(rawName, lowerName) {
    const key = Object.prototype.hasOwnProperty.call(this.vars, rawName) ? rawName : lowerName;
    const value = this.vars[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`变量 "${key}" 不是有限实数`);
    }
    return value;
  }

  parseAtom() {
    const token = this.next();
    if (token.type === 'num') return token.value;
    if (token.type === 'id') {
      const next = this.peek();
      const name = token.value.toLowerCase();
      const fn = FUNCTIONS[name];
      if (next && next.type === 'op' && next.value === '(') {
        // 已知函数才当调用；已知变量后接括号是隐式乘法，如 x(x+1)。
        if (fn) {
          this.next();
          const args = [];
          if (!(this.peek()?.type === 'op' && this.peek()?.value === ')')) {
            args.push(this.parseExpression());
            while (this.peek()?.type === 'op' && this.peek()?.value === ',') {
              this.next();
              args.push(this.parseExpression());
            }
          }
          this.expectOp(')');
          return fn(...args);
        }
        if (Object.prototype.hasOwnProperty.call(this.vars, token.value)
          || Object.prototype.hasOwnProperty.call(this.vars, name)) {
          return this.readVariable(token.value, name);
        }
        throw new ReferenceError(`未知函数 "${token.value}"`);
      }
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
      if (Object.prototype.hasOwnProperty.call(this.vars, token.value)
        || Object.prototype.hasOwnProperty.call(this.vars, name)) {
        return this.readVariable(token.value, name);
      }
      throw new ReferenceError(`未定义变量 "${token.value}"`);
    }
    if (token.type === 'op' && token.value === '(') {
      const value = this.parseExpression();
      this.expectOp(')');
      return value;
    }
    if (token.type === 'op' && token.value === '|') {
      const value = this.parseExpression();
      this.expectOp('|');
      return Math.abs(value);
    }
    throw new SyntaxError(`意外的记号 "${token.value}"`);
  }
}

/**
 * 数值求值。
 * @param {string|number} expr
 * @param {Record<string, number>} [vars]
 * @returns {number}
 * @throws {SyntaxError|ReferenceError|RangeError} 表达式非法或变量缺失
 */
export function evalNumeric(expr, vars = {}) {
  if (typeof expr === 'number') {
    if (!Number.isFinite(expr)) throw new RangeError('表达式不是有限实数');
    return expr;
  }
  if (typeof expr !== 'string') throw new TypeError('表达式必须是字符串或数字');
  const source = normalizeExpression(expr).trim();
  if (source === '') throw new SyntaxError('表达式为空');
  const tokens = tokenize(source);
  const parser = new Parser(tokens, vars);
  const value = parser.parseExpression();
  if (parser.index !== tokens.length) {
    throw new SyntaxError(`表达式有剩余记号 "${tokens[parser.index].value}"`);
  }
  if (typeof value !== 'number') throw new TypeError('表达式未求值为数值');
  return value;
}

/**
 * 把等式拆成左右两边；没有 `=` 时右边视为 0。
 * @param {string} text
 * @returns {{lhs: string, rhs: string}}
 */
export function parseEquation(text) {
  if (typeof text !== 'string') throw new TypeError('等式必须是字符串');
  const normalized = normalizeExpression(text);
  const parts = normalized.split('=');
  if (parts.length > 2) throw new SyntaxError('等式只能包含一个 "="');
  const lhs = parts[0].trim();
  const rhs = (parts[1] ?? '0').trim();
  if (lhs === '') throw new SyntaxError('等式左边为空');
  return { lhs, rhs };
}

/**
 * 比较两个实数是否在容差内相等。
 * @param {number} a
 * @param {number} b
 * @param {{abs?: number, rel?: number}|number} [tol]
 * @returns {boolean}
 */
export function sameValue(a, b, tol) {
  let abs = 1e-9;
  let rel = 1e-9;
  if (typeof tol === 'number' && Number.isFinite(tol)) abs = Math.abs(tol);
  else if (tol && typeof tol === 'object') {
    if (Number.isFinite(tol.abs)) abs = Math.abs(tol.abs);
    if (Number.isFinite(tol.rel)) rel = Math.abs(tol.rel);
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return a === b && Number.isFinite(a);
  }
  if (a === b) return true;
  const tolerance = Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
  return Math.abs(a - b) <= tolerance;
}

/** 解析数字；失败返回 null（不抛错，供格式检查使用）。 */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const parsed = Number(text);
  if (Number.isFinite(parsed) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    return parsed;
  }
  return null;
}
