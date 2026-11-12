import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryJSON, MAX_QUERY_DOCUMENT_BYTES } from '../ui/query.js';

test('字段路径、数组索引和 this 前缀', () => {
  assert.equal(queryJSON('{"key":{"subkey":[10,20]}}','.key.subkey[1]'),'20');
  assert.equal(queryJSON('[[1,2],[3,4]]','[0][1]'),'2');
  assert.equal(queryJSON('{"中文":true}','this["中文"]'),'true');
  assert.equal(queryJSON('[1,2]','.length'),'2');
  assert.equal(queryJSON('{"n":7}','(this.n)'),'7');
});
test('map/filter 链式筛选和索引参数', () => {
  const input='[{"val":1,"enabled":true},{"val":2,"enabled":false},{"val":3,"enabled":true}]';
  assert.equal(queryJSON(input,'.filter(x => x.enabled && x.val >= 2).map(x => x.val)'), '[\n  3\n]');
  assert.equal(queryJSON(input,'.filter((x, i) => i < 2).map(x => x.val)'), '[\n  1,\n  2\n]');
  assert.equal(queryJSON('[0,1,2]','.filter(x => x)'), '[\n  1,\n  2\n]');
});
test('保留大整数、精确比较、十进制和负数', () => {
  const input='[{"n":900719925474099312345},{"n":900719925474099312346}]';
  assert.equal(queryJSON(input,'.filter(x => x.n === 900719925474099312346).map(x => x.n)'), '[\n  900719925474099312346\n]');
  assert.equal(queryJSON('[-2,-1,0,1]','.filter(x => x < -1)'), '[\n  -2\n]');
  assert.equal(queryJSON('{"n":0.12345678901234567890}','.n'),'0.12345678901234567890');
});
test('投影、条件表达式和空值回退', () => {
  assert.equal(queryJSON('[{"name":"A"},{}]','.map(x => ({name: x.name ?? "未知"}))'), '[\n  {\n    "name": "A"\n  },\n  {\n    "name": "未知"\n  }\n]');
  assert.equal(queryJSON('[1,2]','.map(x => x > 1 ? "yes" : "no")'), '[\n  "no",\n  "yes"\n]');
});
test('拒绝不存在的结果、非法输入和语法', () => {
  assert.throws(()=>queryJSON('{}','.missing'), /不存在/);
  assert.throws(()=>queryJSON('{bad','.x'), /JSON 格式/);
  assert.throws(()=>queryJSON('{}',''), /请输入/);
  assert.throws(()=>queryJSON('{}','.x; this'), /语法错误/);
  assert.throws(()=>queryJSON('{}','.x('), /语法错误/);
  assert.throws(()=>queryJSON('1','.map(x => x)'), /只能用于数组/);
  assert.throws(()=>queryJSON('[]','.map(x => { return x })'), /箭头表达式/);
});
test('拒绝任意代码执行、全局访问、赋值与原型路径', () => {
  for(const expression of ['globalThis','window','fetch("https://example.test")','this.constructor','this["__proto__"]','this.constructor.constructor("return this")()','this.x = 1','(()=>this)()','.map(x => x.constructor)','.map(x => ++x)','.map(async x => x)','.map(x => import("x"))','.map(x => /x/)']) {
    assert.throws(()=>queryJSON('[1,2]',expression), undefined, expression);
  }
});
test('表达式、输入、输出和总计算量上限', () => {
  assert.throws(()=>queryJSON('{}',' '.repeat(1)+'x'.repeat(1025)), /1024/);
  assert.throws(()=>queryJSON(' '.repeat(MAX_QUERY_DOCUMENT_BYTES+1),'this'), /1 MiB/);
  assert.throws(()=>queryJSON(JSON.stringify(Array(30000).fill({x:1})),'.map(x => x.x)'), /计算量/);
  assert.throws(()=>queryJSON(JSON.stringify(Array(200).fill('x'.repeat(200))),'.map(x => this)'), /1 MiB|计算量/);
});
