// Business logic only: a stub editor and bridge, no browser or desktop window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

const result = await build({
  entryPoints: ['plugins/json-tool/ui/app.js'], bundle: true, write: false, format: 'iife',
  plugins: [{ name: 'business-fixture', setup(build) {
    build.onResolve({ filter: /^vanilla-jsoneditor$/ }, () => ({ path: 'editor', namespace: 'fixture' }));
    build.onResolve({ filter: /third_party\/sinan\/packages\/plugin-sdk\/ui\/index.js$/ }, () => ({ path: 'bridge', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'editor'
      ? 'export const createJSONEditor = options => globalThis.createEditor(options);'
      : 'export const readLaunch = () => globalThis.readLaunch(); export const ready = () => {}; export const readData = () => globalThis.readData(); export const writeData = (...args) => globalThis.writeData(...args);' }));
  } }]
});
const script = result.outputFiles[0].text;
const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(initial = '', launch = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { disabled: true, hidden: true, textContent: '', handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
    return elements.get(id);
  };
  let content, props, now = 0, timerId = 0;
  const timers = new Map();
  let doc = { revision: 4, value: { text: initial } };
  let write = async (revision, value) => { assert.equal(revision, doc.revision); doc = { revision: revision + 1, value }; return doc; };
  const context = {
    TextEncoder, setTimeout(fn, delay) { const id = ++timerId; timers.set(id, {fn, at:now+delay}); return id; }, clearTimeout(id) { timers.delete(id); },
    document: { querySelector: element, addEventListener() {} },
    createEditor(options) {
      props = options.props; content = props.content;
      return { get: () => content, set: value => { content = value; }, update: value => { content = value; }, updateProps() {}, focus() {} };
    },
    readLaunch: async () => structuredClone(launch), readData: async () => structuredClone(doc), writeData: (...args) => write(...args),
  };
  vm.runInNewContext(script, context); await settle();
  async function advance(ms) {
    const target = now + ms;
    for (let count=0; count<100; count++) {
      const next=[...timers].filter(([,task])=>task.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now=next[1].at; next[1].fn(); await settle();
    }
    now=target;
  }
  return {
    advance,
    expression(value) { element('#query').value=value; element('#query').handlers.input({isComposing:false}); },
    element, text: () => content.text, doc: () => doc,
    input(text) { content = { text }; props.onChange(content); },
    click(id) { element(id).handlers.click(); },
    async save() { await advance(700); },
    writer(fn) { write = fn; },
    settle,
  };
}

test('兼容旧草稿，格式化和压缩后持久化原始数值', async () => {
  const input = '{"big":900719925474099312345,"n":[1,2]}';
  const app = await fixture(input);
  assert.equal(app.text(), input);
  app.click('#format'); await app.save();
  assert.match(app.text(), /\n/);
  assert.equal(app.doc().value.text, app.text());
  app.click('#compact'); await app.save();
  assert.equal(app.doc().value.text, input);
});
test('格式错误保留输入，清空后保存空草稿', async () => {
  const app = await fixture(); app.input('{broken'); app.click('#format');
  assert.equal(app.text(), '{broken'); assert.equal(app.element('#error').hidden, false);
  app.click('#clear'); await app.save(); assert.equal(app.doc().value.text, '');
});
test('写入期间继续编辑，随后使用新 revision 保存最新内容', async () => {
  const app = await fixture(); let complete, calls = [];
  app.writer((revision, value) => {
    calls.push({ revision, value });
    return calls.length === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ revision: revision + 1 });
  });
  app.input('1'); await app.save(); app.input('2'); await app.save();
  assert.equal(calls.length, 1);
  complete({ revision: 5 }); await app.settle();
  assert.equal(calls.length, 2); assert.equal(calls[1].revision, 5); assert.equal(calls[1].value.text, '2');
});
test('存储冲突保留当前输入，停止自动写入，仅显式恢复旧草稿', async () => {
  const app = await fixture('{"old":true}'); let writes = 0;
  app.writer(async () => { writes++; throw new Error('conflict'); });
  app.input('{"new":true}'); await app.save();
  assert.equal(app.text(), '{"new":true}'); assert.equal(app.element('#reload').hidden, false);
  app.input('{"newer":true}'); await app.save(); assert.equal(writes, 1);
  app.click('#reload'); await app.settle(); assert.equal(app.text(), '{"old":true}');
});

test('打开参数优先于旧草稿，仅编辑后保存；显式恢复仍读取原草稿', async () => {
  const original = '{"old":true}', incoming = ' \n {"new":[900719925474099312345]} \n';
  const app = await fixture(original, { commandId: 'open', input: incoming });
  assert.equal(app.text(), incoming);
  await app.save(); assert.equal(app.doc().value.text, original);
  app.click('#format'); await app.save();
  assert.equal(app.doc().value.text, app.text());
  assert.match(app.text(), /900719925474099312345/);
});
test('显式空输入与普通打开区分，且不覆盖旧草稿', async () => {
  const app = await fixture('{"old":true}', { commandId: 'open', input: '' });
  assert.equal(app.text(), '');
  await app.save(); assert.equal(app.doc().value.text, '{"old":true}');
});

test('筛选直接应用并保存，筛选错误保留当前文档', async () => {
  const app = await fixture('{"items":[{"val":1},{"val":2}]}');
  app.element('#query').value='.items.filter(x => x.val > 1).map(x => x.val)';
  app.element('#query-form').handlers.submit({preventDefault(){}});
  assert.equal(app.text(), '[\n  2\n]');
  await app.save();assert.equal(app.doc().value.text,app.text());
  const before=app.text();
  app.element('#query').value='this.constructor';
  app.element('#query-form').handlers.submit({preventDefault(){}});
  assert.equal(app.text(),before);assert.equal(app.element('#error').hidden,false);
});

test('实时筛选防抖，修改表达式始终从原文计算，清空精确恢复原文', async () => {
  const original = '{"items":[{"val":1},{"val":2},{"val":3}]}';
  const app = await fixture(original);
  app.expression('.items.filter(x => x.val > 1)');
  await app.advance(179); assert.equal(app.text(), original);
  await app.advance(1); assert.equal(app.text(), '[\n  {\n    "val": 2\n  },\n  {\n    "val": 3\n  }\n]');
  app.expression('.items.map(x => x.val)'); await app.advance(180);
  assert.equal(app.text(), '[\n  1,\n  2,\n  3\n]');
  app.expression(''); assert.equal(app.text(), original);
});
test('快速输入只应用最新表达式，无效片段保留上次成功结果', async () => {
  const app = await fixture('{"a":1,"b":2}');
  app.expression('.a'); await app.advance(100);
  app.expression('.b'); await app.advance(179); assert.equal(app.text(), '{"a":1,"b":2}');
  await app.advance(1); assert.equal(app.text(), '2');
  app.expression('.b['); await app.advance(180); assert.equal(app.text(), '2');
  app.expression('.a'); await app.advance(180); assert.equal(app.text(), '1');
});
test('直接编辑或工具操作结束筛选，过时定时器不会覆盖新文档', async () => {
  const app = await fixture('{"a":1}');
  app.expression('.a'); app.input('{"new":true}'); await app.advance(200);
  assert.equal(app.text(), '{"new":true}'); assert.equal(app.element('#query').value, '');
  app.expression('.new'); await app.advance(180); assert.equal(app.text(), 'true');
  app.click('#clear'); await app.advance(200); assert.equal(app.text(), '');
  app.expression(''); assert.equal(app.text(), '');
});
test('输入法组合期间不筛选，组合结束后应用', async () => {
  const app = await fixture('{"中文":123}');
  app.element('#query').handlers.compositionstart();
  app.expression('this["中文"]'); await app.advance(400); assert.equal(app.text(), '{"中文":123}');
  app.element('#query').handlers.compositionend(); await app.advance(180); assert.equal(app.text(), '123');
});
