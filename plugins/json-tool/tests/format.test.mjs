import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJSON, contentText, parser } from '../ui/format.js';

test('格式化嵌套对象、数组和中文，使用两个空格', () => {
  assert.equal(formatJSON('{"工具":[true,null,{"名字":"司南"}]}'), '{\n  "工具": [\n    true,\n    null,\n    {\n      "名字": "司南"\n    }\n  ]\n}');
});
test('压缩仅去除结构空白，保留字符串空格和转义', () => {
  const compact = '{"text":"a b\\n\\\"c","arr":[1,2]}';
  assert.equal(formatJSON(formatJSON(compact), true), compact);
});
test('格式化和压缩完整保留大整数、小数精度和指数写法', () => {
  const compact = '{"big":9007199254740993123456789,"decimal":0.12345678901234567890,"exp":1e+100,"negative":-0}';
  assert.equal(formatJSON(formatJSON(compact), true), compact);
  assert.equal(contentText({ json: parser.parse(compact) }), formatJSON(compact));
});
test('支持 JSON 顶层基础值', () => {
  for (const input of ['null', 'true', 'false', '12345678901234567890', '"司南"', '[]', '{}']) {
    assert.equal(formatJSON(input), input);
  }
});
test('拒绝空输入、非法 JSON、尾随内容和重复键，并报告位置', () => {
  assert.throws(() => formatJSON('  '), /请输入 JSON/);
  for (const input of ['{"a":}', '[1,]', '{', 'true false', '{"x":NaN}', '{"x":Infinity}']) {
    assert.throws(() => formatJSON(input), /JSON 格式错误/);
  }
  assert.throws(() => formatJSON('{\n  "a":\n}'), /第 3 行，第 1 列/);
  assert.throws(() => formatJSON('{"a":1,"a":2}'), /重复的键/);
});
test('草稿按原始文本往返，保留编辑中的非法内容', () => {
  assert.equal(contentText({ text: '{broken' }), '{broken');
  assert.equal(contentText({ text: '' }), '');
});
