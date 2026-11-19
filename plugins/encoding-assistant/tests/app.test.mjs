import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as tools from '../ui/tools.js';

const source = (await readFile(new URL('../ui/app.js', import.meta.url), 'utf8')).replace(/^import [^;]+;\s*/gm, '');
const now = 1700000000123;

function node(tag = 'div') {
  const attributes = {};
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    events: {},
    attributes,
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    tabIndex: 0,
    classList: {
      add(...names) { names.forEach(n => classes.add(n)); },
      remove(...names) { names.forEach(n => classes.delete(n)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    },
    set className(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name);
    },
    get className() { return [...classes].join(' '); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    replaceWith(next) { this._replacedBy = next; },
    get lastElementChild() { return this.children.at(-1); },
    add(option) { this.children.push(option); this.value ??= option.value; },
    addEventListener(type, callback) {
      this.events[type] ??= [];
      this.events[type].push(callback);
    },
    async dispatch(type, event = {}) {
      for (const cb of this.events[type] ?? []) await cb(event);
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
      if (name === 'src') this._src = String(value);
    },
    getAttribute(name) { return attributes[name] ?? null; },
    hasAttribute(name) { return Object.hasOwn(attributes, name); },
    removeAttribute(name) { delete attributes[name]; },
    set src(value) { this.setAttribute('src', value); },
    get src() { return this._src ?? ''; },
    focus() {},
    click() { if (!this.disabled) return this.dispatch('click'); },
  };
  if (tag === 'canvas') {
    el.getContext = () => ({ fillStyle: '', fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }) });
  }
  return el;
}

function findAll(root, predicate, out = []) {
  for (const child of root.children ?? []) {
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}

function textOf(el) {
  return el.textContent || (el.children ?? []).map(textOf).join('');
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function fixture(launch, options = {}) {
  const nodes = Object.fromEntries(['#toolbar', '#workspace', '#status', '#meta'].map(id => [id, node()]));
  const document = Object.assign(node('document'), {
    querySelector: id => nodes[id],
    createElement: tag => node(tag),
    createElementNS: (_ns, tag) => node(tag),
  });
  const copied = [];
  let storage = options.storage ?? { revision: 1, value: null };
  let generation = 0;
  class FixedDate extends Date { static now() { return now; } }
  class Option { constructor(label, value) { Object.assign(this, {label, value}); } }

  await vm.runInNewContext(source, {
    ...tools,
    Date: FixedDate,
    Option,
    TextEncoder,
    navigator: options.navigator ?? { platform: 'MacIntel' },
    setTimeout: () => 1,
    clearTimeout() {},
    document,
    uuidForms: () => tools.uuidForms({getRandomValues: bytes => bytes.fill(++generation)}),
    ready() {},
    readLaunch: async () => launch,
    readData: options.readData ?? (async () => storage),
    writeData: options.writeData ?? (async (_rev, value) => {
      storage = { revision: storage.revision + 1, value };
      return storage;
    }),
    writeClipboardText: options.writeClipboardText ?? (async value => { copied.push(value); }),
    readClipboardImage: options.readClipboardImage ?? (async () => null),
    openImage: options.openImage ?? (async () => null),
  });

  // Allow microtask ticks from async showTime / showQR initial reads to settle.
  await new Promise(resolve => setTimeout(resolve, 0));

  return {
    document,
    copied,
    toolbar: nodes['#toolbar'],
    workspace: nodes['#workspace'],
    status: nodes['#status'],
    meta: nodes['#meta'],
    getStorage: () => storage,
    findAll: predicate => [...findAll(nodes['#toolbar'], predicate), ...findAll(nodes['#workspace'], predicate)],
  };
}

test('UUID 快捷键按行复制，复制不禁用按钮，重新生成后复制新结果', async () => {
  const {document, copied, workspace, toolbar, status} = await fixture({commandId: 'uuid'});
  const rows = findAll(workspace, el => el.classList.contains('uuid-row'));
  assert.equal(rows.length, 4);
  let prevented = 0;
  const keydown = (key, modifiers) => document.dispatch('keydown', {
    key, ctrlKey: false, metaKey: false, preventDefault() { prevented++; }, ...modifiers,
  });
  for (const [index, row] of rows.entries()) {
    const key = index + 1;
    const copyBtn = row.lastElementChild.lastElementChild;
    assert.equal(copyBtn.getAttribute('aria-keyshortcuts'), `Meta+${key} Control+${key}`);
    await keydown(String(key), index % 2 ? {ctrlKey: true} : {metaKey: true});
    await tick();
    assert.equal(copyBtn.disabled, false);
    assert.equal(copyBtn.hasAttribute('data-copied'), true);
  }
  assert.deepEqual(copied, rows.map(row => row.children[1].textContent));
  assert.match(status.textContent, /^已复制/);

  await keydown('1', {ctrlKey: true, isComposing: true});
  await keydown('1', {metaKey: true, repeat: true});
  await keydown('1', {ctrlKey: true, shiftKey: true});
  await keydown('1', {});
  await keydown('5', {metaKey: true});
  assert.equal(prevented, 4);

  const regenBtn = findAll(toolbar, el => el.tagName === 'BUTTON')[0];
  await regenBtn.click();
  const refreshedRows = findAll(workspace, el => el.classList.contains('uuid-row'));
  await keydown('1', {ctrlKey: true});
  await tick();
  assert.equal(copied[4], refreshedRows[0].children[1].textContent);
  assert.notEqual(copied[4], copied[0]);
});

test('时间转换：普通打开与内容入口、单位切换、现在及自定义时区持久化', async () => {
  for (const input of [undefined, '1700000000', '2024-01-01T00:00Z', '']) {
    const {document, toolbar, workspace} = await fixture({commandId: 'time', input});
    const source = findAll(toolbar, el => el.tagName === 'INPUT')[0];
    assert.equal(source.value, input ?? String(now));
    const unixValues = findAll(workspace, el => el.classList?.contains('metric-value'));
    const zoneRows = findAll(workspace, el => el.classList?.contains('time-row'));
    assert.equal(unixValues.length, 2);
    assert.equal(zoneRows.length, 2);
    if (input === '') {
      assert.equal(unixValues[0].textContent, '—');
      assert.equal(zoneRows[0].children[1].textContent, '—');
    } else if (input === undefined) {
      assert.equal(unixValues[1].textContent, String(now));
    }
    assert.equal(document.events.keydown, undefined);
  }

  const {toolbar, workspace, getStorage} = await fixture({commandId: 'time', input: '10000000000'});
  const unitButtons = findAll(toolbar, el => el.hasAttribute?.('aria-pressed'));
  assert.equal(unitButtons[0].getAttribute('aria-pressed'), 'true');
  const unixValues = findAll(workspace, el => el.classList?.contains('metric-value'));
  assert.equal(unixValues[0].textContent, '10000000');

  await unitButtons[1].click(); // seconds
  assert.equal(unitButtons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(unixValues[0].textContent, '10000000000');

  const zoneForm = findAll(workspace, el => el.tagName === 'FORM')[0];
  const zoneInput = findAll(zoneForm, el => el.tagName === 'INPUT')[0];
  zoneInput.value = 'asia/tokyo';
  await zoneForm.dispatch('submit', { preventDefault() {} });
  await tick();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(getStorage().value)), { zones: ['Asia/Tokyo'] });
  const rowsAfterAdd = findAll(workspace, el => el.classList?.contains('time-row'));
  assert.equal(rowsAfterAdd.length, 3);
  const removeTokyo = findAll(rowsAfterAdd[2], el => el.getAttribute('aria-label') === '删除 Asia/Tokyo')[0];
  await removeTokyo.click();
  await tick();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(getStorage().value)), { zones: [] });
  assert.equal(findAll(workspace, el => el.classList?.contains('time-row')).length, 2);
});

test('Base64：实时编码、对调切解码、错误内联提示与快捷键复制', async () => {
  const {document, copied, toolbar, workspace} = await fixture({commandId: 'base64'});
  const input = findAll(workspace, el => el.tagName === 'TEXTAREA')[0];
  const output = findAll(workspace, el => el.tagName === 'PRE')[0];
  const [encodeBtn, decodeBtn] = findAll(toolbar, el => el.hasAttribute('aria-pressed'));
  const [swapBtn, clearBtn] = findAll(toolbar, el => el.tagName === 'BUTTON' && !el.hasAttribute('aria-pressed'));
  const copyBtn = findAll(workspace, el => el.classList.contains('copy-btn'))[0];

  assert.equal(encodeBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(copyBtn.disabled, true);
  assert.equal(swapBtn.disabled, true);

  input.value = '司南';
  await input.dispatch('input', { isComposing: false });
  assert.equal(output.textContent, '5Y+45Y2X');
  assert.equal(copyBtn.disabled, false);
  assert.equal(swapBtn.disabled, false);

  await document.dispatch('keydown', {
    key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {},
  });
  await tick();
  assert.deepEqual(copied, ['5Y+45Y2X']);

  await swapBtn.click();
  assert.equal(decodeBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(input.value, '5Y+45Y2X');
  assert.equal(output.textContent, '司南');

  input.value = '%%';
  await input.dispatch('input', { isComposing: false });
  const alert = findAll(workspace, el => el.getAttribute('role') === 'alert')[0];
  assert.match(textOf(alert), /Base64/);
  assert.equal(copyBtn.disabled, true);

  await clearBtn.click();
  assert.equal(input.value, '');
  assert.equal(output.hidden, true);
});

test('Hash：同步计算 5 种摘要、大小写切换与数字快捷键复制', async () => {
  const {document, copied, toolbar, workspace} = await fixture({commandId: 'hash'});
  const input = findAll(workspace, el => el.tagName === 'TEXTAREA')[0];
  const [lowerBtn, upperBtn] = findAll(toolbar, el => el.hasAttribute('aria-pressed'));
  const digests = findAll(workspace, el => el.classList.contains('hash-digest'));
  assert.equal(digests.length, 5);
  assert.equal(digests[2].textContent, tools.hashText('', 'SHA-256'));

  input.value = 'abc';
  await input.dispatch('input', { isComposing: false });
  assert.equal(digests[0].textContent, tools.hashText('abc', 'MD5'));
  assert.equal(digests[2].textContent, tools.hashText('abc', 'SHA-256'));

  await upperBtn.click();
  assert.equal(upperBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(digests[2].textContent, tools.hashText('abc', 'SHA-256').toUpperCase());

  await document.dispatch('keydown', {
    key: '3', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {},
  });
  await tick();
  assert.deepEqual(copied, [tools.hashText('abc', 'SHA-256').toUpperCase()]);
  await lowerBtn.click();
  assert.equal(digests[2].textContent, tools.hashText('abc', 'SHA-256'));
});

test('二维码：链接实时编码与图片解码流程', async () => {
  const {toolbar, workspace} = await fixture({commandId: 'qr', input: 'https://example.test'});
  const tabs = findAll(toolbar, el => el.getAttribute('role') === 'tab');
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  const qrInput = findAll(workspace, el => el.tagName === 'TEXTAREA')[0];
  assert.equal(qrInput.value, 'https://example.test');
  const spec = findAll(workspace, el => el.classList.contains('badge') && el.textContent.includes('模块'))[0];
  assert.match(spec.textContent, /\d+ × \d+ 模块 · 纠错 M/);

  // Tab switch via ArrowRight
  await toolbar.children[0].dispatch('keydown', { key: 'ArrowRight', target: tabs[0], preventDefault() {} });
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');

  // Decode flow with launch.image
  const qr = tools.encodeQR('sinan-qr-test');
  const count = qr.getModuleCount();
  const scale = 4;
  const size = (count + 8) * scale;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.floor(y / scale) - 4;
      const c = Math.floor(x / scale) - 4;
      const dark = r >= 0 && c >= 0 && r < count && c < count && qr.isDark(r, c);
      const val = dark ? 0 : 255;
      rgba.set([val, val, val, 255], (y * size + x) * 4);
    }
  }

  // Override createElement in a dedicated decode fixture so img.decode & canvas.getImageData work cleanly.
  const nodes = Object.fromEntries(['#toolbar', '#workspace', '#status', '#meta'].map(id => [id, node()]));
  const doc = Object.assign(node('document'), {
    querySelector: id => nodes[id],
    createElement(tag) {
      const n = node(tag);
      if (tag === 'img') {
        n.naturalWidth = size;
        n.naturalHeight = size;
        n.decode = async () => {};
      } else if (tag === 'canvas') {
        n.getContext = () => ({ fillStyle: '', fillRect() {}, drawImage() {}, getImageData: () => ({ data: rgba, width: size, height: size }) });
      }
      return n;
    },
    createElementNS: (_ns, tag) => node(tag),
  });
  let clipboardCalls = 0;
  await vm.runInNewContext(source, {
    ...tools,
    Date,
    Option: class { constructor(l, v) { Object.assign(this, {label: l, value: v}); } },
    TextEncoder,
    navigator: { platform: 'MacIntel' },
    setTimeout: () => 1,
    clearTimeout() {},
    document: doc,
    ready() {},
    readLaunch: async () => ({ commandId: 'qr', image: { url: 'sinan-plugin://img/1.png' } }),
    readData: async () => ({ value: null }),
    writeClipboardText: async () => {},
    readClipboardImage: async () => { clipboardCalls++; throw new Error('读取失败'); },
    openImage: async () => null,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const decodedPre = findAll(nodes['#workspace'], el => el.tagName === 'PRE')[0];
  assert.equal(decodedPre.textContent, 'sinan-qr-test');
  // Subsequent clipboard error before loading a new image must preserve existing decoded result.
  const pasteBtn = findAll(nodes['#toolbar'], el => el.tagName === 'BUTTON' && textOf(el).includes('剪贴板'))[0];
  await pasteBtn.click();
  await tick();
  assert.equal(clipboardCalls, 1);
  assert.equal(decodedPre.textContent, 'sinan-qr-test');
  assert.equal(nodes['#status'].textContent, '读取失败');
});
