import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as tools from '../ui/tools.js';

const source = (await readFile(new URL('../ui/app.js', import.meta.url), 'utf8')).replace(/^import [^;]+;\s*/gm, '');
const now = 1700000000123;

function node() {
  return {
    children: [], events: {}, attributes: {}, classList: {toggle() {}},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    get lastElementChild() { return this.children.at(-1); },
    add(option) { this.value ??= option.value; },
    addEventListener(type, callback) { this.events[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    click() { if (!this.disabled) return this.events.click?.(); },
  };
}

async function fixture(launch) {
  const nodes = Object.fromEntries(['#title', '#actions', '#status', '#panel'].map(id => [id, node()]));
  const document = Object.assign(node(), {querySelector: id => nodes[id], createElement: node});
  const copied = [];
  let generation = 0;
  class FixedDate extends Date { static now() { return now; } }
  class Option { constructor(label, value) { Object.assign(this, {label, value}); } }
  await vm.runInNewContext(source, {
    ...tools, Date: FixedDate, Option, document,
    uuidForms: () => tools.uuidForms({getRandomValues: bytes => bytes.fill(++generation)}),
    ready() {}, readLaunch: async () => launch, readData: async () => ({value: null}),
    writeClipboardText: async value => { copied.push(value); },
  });
  return {document, copied, panel: nodes['#panel'], actions: nodes['#actions']};
}

test('UUID 快捷键按行复制，重新生成后复制新结果', async () => {
  const {document, copied, panel, actions} = await fixture({commandId: 'uuid'});
  let prevented = 0;
  const keydown = (key, modifiers) => document.events.keydown({
    key, ctrlKey: false, metaKey: false, preventDefault() { prevented++; }, ...modifiers,
  });
  for (const [index, row] of panel.children.entries()) {
    const key = index + 1;
    assert.equal(row.lastElementChild.attributes['aria-keyshortcuts'], `Meta+${key} Control+${key}`);
    keydown(String(key), index % 2 ? {ctrlKey: true} : {metaKey: true});
  }
  assert.deepEqual(copied, panel.children.map(row => row.children[0].children[1].textContent));
  keydown('1', {ctrlKey: true, isComposing: true});
  keydown('1', {metaKey: true, repeat: true});
  keydown('1', {ctrlKey: true, shiftKey: true});
  keydown('1', {});
  keydown('5', {metaKey: true});
  assert.equal(prevented, 4);
  actions.children[0].click();
  keydown('1', {ctrlKey: true});
  assert.equal(copied[4], panel.children[0].children[0].children[1].textContent);
  assert.notEqual(copied[4], copied[0]);
});

test('时间普通打开显示当前时间，内容入口保留原始输入', async () => {
  for (const input of [undefined, '1700000000', '2024-01-01T00:00Z', '']) {
    const {document, panel} = await fixture({commandId: 'time', input});
    assert.equal(panel.children[0].children[0].value, input ?? String(now));
    const rows = panel.children[1].children;
    assert.equal(rows.length, input === '' ? 2 : 4);
    if (input === undefined) assert.equal(rows.at(-1).children[0].children[1].textContent, String(now));
    assert.equal(document.events.keydown, undefined);
  }
});
