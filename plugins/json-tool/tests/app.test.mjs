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
  let content, props, timer, doc = { revision: 4, value: { text: initial } };
  let write = async (revision, value) => { assert.equal(revision, doc.revision); doc = { revision: revision + 1, value }; return doc; };
  const context = {
    TextEncoder, setTimeout(fn) { timer = fn; }, clearTimeout() { timer = undefined; },
    document: { querySelector: element, addEventListener() {} },
    createEditor(options) {
      props = options.props; content = props.content;
      return { get: () => content, set: value => { content = value; }, update: value => { content = value; }, updateProps() {}, focus() {} };
    },
    readLaunch: async () => structuredClone(launch), readData: async () => structuredClone(doc), writeData: (...args) => write(...args),
  };
  vm.runInNewContext(script, context); await settle();
  return {
    element, text: () => content.text, doc: () => doc,
    input(text) { content = { text }; props.onChange(content); },
    click(id) { element(id).handlers.click(); },
    async save() { timer?.(); timer = undefined; await settle(); },
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
