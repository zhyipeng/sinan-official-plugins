import { parseExpressionAt } from 'acorn';
import { compareLosslessNumber, isLosslessNumber, LosslessNumber } from 'lossless-json';
import { parser } from './format.js';

export const MAX_QUERY_BYTES = 1024;
export const MAX_QUERY_DOCUMENT_BYTES = 1024 * 1024;
const MAX_STEPS = 100000;
const MAX_DEPTH = 48;
const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();

function number(value) {
  if (isLosslessNumber(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new LosslessNumber(String(value));
  throw new Error('此操作需要数字');
}
function truth(value) {
  return isLosslessNumber(value) ? compareLosslessNumber(value, new LosslessNumber('0')) !== 0 : !!value;
}
function keyOf(value) {
  if (isLosslessNumber(value)) value = value.value;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('字段名必须为字符串或索引');
  const key = String(value);
  if (blockedKeys.has(key)) throw new Error('不支持访问原型或构造函数');
  return key;
}
function property(value, key) {
  key = keyOf(key);
  if (value === null || value === undefined) throw new Error('无法从空值读取字段');
  if (key === 'length' && (Array.isArray(value) || typeof value === 'string')) return value.length;
  if (typeof value !== 'object' || isLosslessNumber(value)) return undefined;
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
function compare(left, right) {
  if ((isLosslessNumber(left) || typeof left === 'number') && (isLosslessNumber(right) || typeof right === 'number')) return compareLosslessNumber(number(left), number(right));
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  throw new Error('大小比较需要同类型的数字或字符串');
}
function equal(left, right) {
  if ((isLosslessNumber(left) || typeof left === 'number') && (isLosslessNumber(right) || typeof right === 'number')) return compareLosslessNumber(number(left), number(right)) === 0;
  return left === right;
}

// Interpret only JSON operations. No eval, Function, globals, arbitrary calls,
// statements, assignment, or user-created executable JavaScript is involved.
export function queryJSON(text, expression) {
  if (encoder.encode(text).length > MAX_QUERY_DOCUMENT_BYTES) throw new Error('筛选暂支持不超过 1 MiB 的 JSON');
  if (encoder.encode(expression).length > MAX_QUERY_BYTES) throw new Error('筛选表达式超过 1024 字节');
  expression = expression.trim();
  if (!expression) throw new Error('请输入筛选表达式');
  const source = (expression.startsWith('.') || expression.startsWith('[')) ? `this${expression}` : expression;
  let ast;
  try {
    ast = parseExpressionAt(source, 0, { ecmaVersion: 2022, preserveParens: true });
    if (source.slice(ast.end).trim()) throw new Error();
  } catch { throw new Error('筛选表达式语法错误'); }
  let root;
  try { root = parser.parse(text); } catch { throw new Error('请先修正 JSON 格式'); }
  let steps = MAX_STEPS;
  function step(depth) {
    if (--steps < 0 || depth > MAX_DEPTH) throw new Error('筛选计算量或嵌套深度超过限制');
  }
  function evaluate(node, scope, depth = 0) {
    step(depth);
    switch (node.type) {
      case 'ThisExpression': return root;
      case 'ParenthesizedExpression': return evaluate(node.expression, scope, depth + 1);
      case 'Identifier':
        if (scope.has(node.name)) return scope.get(node.name);
        if (node.name === 'undefined') return undefined;
        throw new Error('仅支持当前 JSON 和箭头函数参数');
      case 'Literal':
        if (node.regex || node.bigint) throw new Error('不支持正则或 BigInt 字面量');
        return typeof node.value === 'number' ? parser.parse(node.raw) : node.value;
      case 'MemberExpression':
        if (node.optional) throw new Error('暂不支持可选链');
        return property(evaluate(node.object, scope, depth + 1), node.computed ? evaluate(node.property, scope, depth + 1) : node.property.name);
      case 'CallExpression': {
        if (node.optional || node.callee.type !== 'MemberExpression' || node.callee.computed || !['map', 'filter'].includes(node.callee.property.name)) throw new Error('仅支持数组 map 和 filter 调用');
        const values = evaluate(node.callee.object, scope, depth + 1);
        const fn = node.arguments[0];
        if (!Array.isArray(values)) throw new Error('map 和 filter 只能用于数组');
        if (node.arguments.length !== 1 || fn?.type !== 'ArrowFunctionExpression' || fn.async || fn.body.type === 'BlockStatement' || fn.params.length < 1 || fn.params.length > 2 || fn.params.some(param => param.type !== 'Identifier')) throw new Error('请使用形如 x => x.val 或 (x, i) => i < 3 的箭头表达式');
        const result = [];
        for (let i = 0; i < values.length; i++) {
          step(depth);
          const local = new Map(scope);
          local.set(fn.params[0].name, values[i]);
          if (fn.params[1]) local.set(fn.params[1].name, i);
          const value = evaluate(fn.body, local, depth + 1);
          if (node.callee.property.name === 'map') result.push(value);
          else if (truth(value)) result.push(values[i]);
        }
        return result;
      }
      case 'LogicalExpression': {
        const left = evaluate(node.left, scope, depth + 1);
        if (node.operator === '&&') return truth(left) ? evaluate(node.right, scope, depth + 1) : left;
        if (node.operator === '||') return truth(left) ? left : evaluate(node.right, scope, depth + 1);
        if (node.operator === '??') return left === null || left === undefined ? evaluate(node.right, scope, depth + 1) : left;
        break;
      }
      case 'BinaryExpression': {
        if (!['===', '!==', '>', '>=', '<', '<='].includes(node.operator)) throw new Error('仅支持 ===、!==、>、>=、<、<= 比较');
        const left = evaluate(node.left, scope, depth + 1), right = evaluate(node.right, scope, depth + 1);
        if (node.operator === '===') return equal(left, right);
        if (node.operator === '!==') return !equal(left, right);
        const order = compare(left, right);
        return node.operator === '>' ? order > 0 : node.operator === '>=' ? order >= 0 : node.operator === '<' ? order < 0 : order <= 0;
      }
      case 'UnaryExpression': {
        if (!['!', '-', '+', 'typeof'].includes(node.operator)) throw new Error('不支持此运算');
        const value = evaluate(node.argument, scope, depth + 1);
        if (node.operator === '!') return !truth(value);
        if (node.operator === 'typeof') return isLosslessNumber(value) ? 'number' : typeof value;
        const n = number(value);
        return node.operator === '+' ? n : new LosslessNumber(n.value.startsWith('-') ? n.value.slice(1) : `-${n.value}`);
      }
      case 'ConditionalExpression': return evaluate(truth(evaluate(node.test, scope, depth + 1)) ? node.consequent : node.alternate, scope, depth + 1);
      case 'ArrayExpression': return node.elements.map(element => {
        if (!element || element.type === 'SpreadElement') throw new Error('不支持数组空位或展开');
        return evaluate(element, scope, depth + 1);
      });
      case 'ObjectExpression': {
        const result = Object.create(null);
        for (const entry of node.properties) {
          if (entry.type !== 'Property' || entry.method || entry.kind !== 'init') throw new Error('不支持对象方法或展开');
          const key = entry.computed ? evaluate(entry.key, scope, depth + 1) : entry.key.type === 'Identifier' ? entry.key.name : entry.key.value;
          result[keyOf(key)] = evaluate(entry.value, scope, depth + 1);
        }
        return result;
      }
    }
    throw new Error('表达式包含不支持的语法');
  }
  const result = evaluate(ast, new Map());
  // Check expanded output before serialization: .map(x => this) can duplicate a
  // large document many times without needing many evaluation steps.
  let outputBudget = MAX_QUERY_DOCUMENT_BYTES;
  function inspect(value, depth = 0) {
    step(depth);
    if (value === undefined) throw new Error('筛选结果不存在，请检查字段或索引');
    if (value === null || typeof value !== 'object' || isLosslessNumber(value)) {
      const token = isLosslessNumber(value) ? value.value : JSON.stringify(value);
      outputBudget -= encoder.encode(token).length;
    } else {
      outputBudget -= 2;
      if (Array.isArray(value)) {
        for (const item of value) { outputBudget--; inspect(item, depth + 1); }
      } else {
        for (const key of Object.keys(value)) { outputBudget -= encoder.encode(JSON.stringify(key)).length + 2; inspect(value[key], depth + 1); }
      }
    }
    if (outputBudget < 0) throw new Error('筛选结果超过 1 MiB');
  }
  inspect(result);
  const output = parser.stringify(result, null, 2);
  if (encoder.encode(output).length > MAX_QUERY_DOCUMENT_BYTES) throw new Error('筛选结果超过 1 MiB');
  return output;
}
