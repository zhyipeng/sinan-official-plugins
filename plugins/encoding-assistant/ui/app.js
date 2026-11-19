import {ready, readLaunch, readData, writeData, writeClipboardText, readClipboardImage, openImage} from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';
import {
  parseTime, formatTime, normalizeZone, savedZones, maxExtraZones,
  textBudget, base64Budget, encodeBase64, decodeBase64,
  hashText, hashAlgorithms, uuidForms, encodeQR, decodeQR,
} from './tools.js';

const toolbar = document.querySelector('#toolbar');
const workspace = document.querySelector('#workspace');
const statusEl = document.querySelector('#status');
const metaEl = document.querySelector('#meta');

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  copy: ['rect x="5.5" y="5.5" width="7.5" height="8.5" rx="1.5"', 'path d="M3.5 10.5H3a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5"'],
  check: ['path d="m3.5 8.5 3 3 6-6.5"'],
  clock: ['circle cx="8" cy="8" r="6"', 'path d="M8 4.8V8l2.2 1.4"'],
  refresh: ['path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.7"', 'path d="M13.5 2.5v2.8h-2.8"'],
  swap: ['path d="M3 5.5h10M10.5 3 13 5.5 10.5 8"', 'path d="M13 10.5H3M5.5 8 3 10.5 5.5 13"'],
  clear: ['path d="M3 4.5h10M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3M4.5 4.5l.6 8.3c0 .6.5 1 1.1 1h3.6c.6 0 1.1-.4 1.1-1l.6-8.3"'],
  close: ['path d="m4.5 4.5 7 7M11.5 4.5l-7 7"'],
  plus: ['path d="M8 3.2v9.6M3.2 8h9.6"'],
  qr: ['rect x="2.5" y="2.5" width="4.5" height="4.5" rx=".8"', 'rect x="9" y="2.5" width="4.5" height="4.5" rx=".8"', 'rect x="2.5" y="9" width="4.5" height="4.5" rx=".8"', 'path d="M9.5 9.5h1.5v1.5H9.5zm2.5 0h1.5M9.5 12.5h4v1"'],
  image: ['rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6"', 'circle cx="5.7" cy="6.1" r="1.1"', 'path d="m3.2 12 3.1-3.1a.9.9 0 0 1 1.3 0l1.9 1.9 1.2-1.2a.9.9 0 0 1 1.3 0l1.8 1.8"'],
  paste: ['rect x="3.5" y="3.2" width="9" height="10.8" rx="1.5"', 'path d="M6 3.2V2.5c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v.7"'],
  alert: ['circle cx="8" cy="8" r="6"', 'path d="M8 5.2v3.3M8 11.2h.01"'],
};

const HASH_BITS = { 'MD5': 128, 'SHA-1': 160, 'SHA-256': 256, 'SHA-384': 384, 'SHA-512': 512 };
const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
const shortcutPrefix = isMac ? '⌘' : 'Ctrl+';
const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const scheduleTimer = typeof setTimeout === 'function' ? setTimeout : () => 0;
const cancelTimer = typeof clearTimeout === 'function' ? clearTimeout : () => {};
const copyTimers = new WeakMap();
let lastStatus = '';

function byteLength(text) {
  return utf8Encoder ? utf8Encoder.encode(text).length : text.length;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svgIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const spec of ICONS[name] ?? []) {
    const space = spec.indexOf(' ');
    const shape = document.createElementNS(SVG_NS, spec.slice(0, space));
    for (const pair of spec.slice(space + 1).matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      shape.setAttribute(pair[1], pair[2]);
    }
    svg.append(shape);
  }
  return svg;
}

function makeButton(label, onClick, className = 'btn', iconName = '') {
  const button = el('button', className);
  button.type = 'button';
  if (iconName) button.append(svgIcon(iconName));
  if (label) button.append(el('span', '', label));
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

function makeInput(name, placeholder = '') {
  const input = el('input');
  input.type = 'text';
  input.setAttribute('aria-label', name);
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

function makeTextarea(id, name, placeholder = '') {
  const area = el('textarea', 'code-area');
  area.id = id;
  area.setAttribute('aria-label', name);
  area.placeholder = placeholder;
  area.spellcheck = false;
  area.autocomplete = 'off';
  return area;
}

function setStatus(message = '', tone = '') {
  let announced = message;
  if (announced && tone === 'ok' && announced === lastStatus) announced += '\u00A0';
  lastStatus = message;
  statusEl.textContent = announced;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

function setMeta(text = '') {
  metaEl.textContent = text;
}

function showError(error) {
  setStatus(error?.message || '操作失败，请重试。', 'error');
}

function makeAlert(message = '') {
  const box = el('div', 'inline-alert');
  box.setAttribute('role', 'alert');
  const text = el('span', '', message);
  box.append(svgIcon('alert'), text);
  return {
    root: box,
    set(next) {
      text.textContent = next;
      box.hidden = !next;
    },
  };
}

function makeCopyButton(label, getValue, compact = true) {
  const button = el('button', compact ? 'btn compact copy-btn' : 'btn copy-btn');
  button.type = 'button';
  button.setAttribute('aria-label', `复制${label}`);
  let icon = svgIcon('copy');
  const text = el('span', '', '复制');
  button.append(icon, text);

  function setVisual(copied, failed) {
    const nextIcon = svgIcon(copied ? 'check' : 'copy');
    icon.replaceWith(nextIcon);
    icon = nextIcon;
    text.textContent = copied ? '已复制' : '复制';
    if (copied) button.setAttribute('data-copied', '');
    else button.removeAttribute('data-copied');
    if (failed) button.setAttribute('data-failed', '');
    else button.removeAttribute('data-failed');
  }

  button.addEventListener('click', async () => {
    const value = typeof getValue === 'function' ? getValue() : getValue;
    if (!value) return;
    cancelTimer(copyTimers.get(button));
    try {
      await writeClipboardText(value);
      setVisual(true, false);
      setStatus(`已复制${label}。`, 'ok');
    } catch {
      setVisual(false, true);
      setStatus('无法写入剪贴板，或结果超过剪贴板限额。可选中结果手动复制。', 'error');
    }
    copyTimers.set(button, scheduleTimer(() => setVisual(false, false), 1600));
  });
  return button;
}

function makeSegmented(label, options, initial, onChange, tabMode = false) {
  const root = el('div', 'segmented');
  root.setAttribute('role', tabMode ? 'tablist' : 'group');
  root.setAttribute('aria-label', label);
  const attr = tabMode ? 'aria-selected' : 'aria-pressed';
  let current = initial;
  const buttons = new Map();

  for (const [value, text, iconName] of options) {
    const button = el('button');
    button.type = 'button';
    if (tabMode) button.setAttribute('role', 'tab');
    if (iconName) button.append(svgIcon(iconName));
    button.append(el('span', '', text));
    button.addEventListener('click', () => {
      if (button.disabled || current === value) return;
      setValue(value);
      onChange(value);
    });
    buttons.set(value, button);
    root.append(button);
  }

  if (tabMode) {
    root.addEventListener('keydown', event => {
      const list = [...buttons.values()];
      const index = list.indexOf(event.target);
      if (index < 0) return;
      let nextIndex = -1;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % list.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + list.length) % list.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = list.length - 1;
      if (nextIndex < 0) return;
      event.preventDefault();
      const target = list[nextIndex];
      target.focus?.();
      target.click();
    });
  }

  function setValue(next) {
    current = next;
    for (const [value, button] of buttons) {
      const active = value === next;
      button.setAttribute(attr, active ? 'true' : 'false');
      if (tabMode) button.tabIndex = active ? 0 : -1;
    }
  }

  function setDisabled(disabled) {
    for (const button of buttons.values()) button.disabled = disabled;
  }

  setValue(initial);
  return { root, get value() { return current; }, setValue, setDisabled, buttons };
}

function bindNumberShortcuts(max, getButton) {
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey ||
        event.ctrlKey === event.metaKey) return;
    const digit = Number(event.key);
    if (!Number.isInteger(digit) || digit < 1 || digit > max) return;
    const target = getButton(digit - 1);
    if (!target || target.disabled) return;
    event.preventDefault();
    target.click();
  });
}

async function showTime(input) {
  const source = makeInput('时间输入', '输入时间戳或 YYYY-MM-DD HH:mm:ss');
  source.maxLength = 96;
  source.value = input ?? String(Date.now());

  const clearBtn = makeButton('', () => {
    source.value = '';
    renderTime();
    source.focus?.();
  }, 'input-clear', 'close');
  clearBtn.setAttribute('aria-label', '清空输入');

  const sourceShell = el('div', 'input-shell toolbar-grow');
  sourceShell.append(svgIcon('clock'), source, clearBtn);

  let currentUnit = 'auto';
  const unitSwitch = makeSegmented('时间戳单位', [
    ['auto', '自动'],
    ['seconds', '秒'],
    ['millis', '毫秒'],
  ], 'auto', value => {
    currentUnit = value;
    renderTime();
  });

  const nowBtn = makeButton('现在', () => {
    currentUnit = 'millis';
    unitSwitch.setValue('millis');
    source.value = String(Date.now());
    renderTime();
  }, 'btn', 'refresh');

  const rightGroup = el('div', 'toolbar-group');
  rightGroup.append(unitSwitch.root, nowBtn);
  toolbar.hidden = false;
  toolbar.replaceChildren(sourceShell, rightGroup);

  const scroll = el('div', 'workspace-scroll scroller');
  const parseAlert = makeAlert();
  parseAlert.set('');

  let unixSec = '';
  let unixMs = '';
  function makeMetricCard(label, getValue) {
    const card = el('div', 'metric-card');
    const body = el('div', 'metric-body');
    const title = el('span', 'metric-label', label);
    const valEl = el('code', 'metric-value', '—');
    valEl.dataset.empty = 'true';
    body.append(title, valEl);
    const copyBtn = makeCopyButton(label, getValue);
    card.append(body, copyBtn);
    return {
      root: card,
      update(next) {
        valEl.textContent = next || '—';
        valEl.dataset.empty = next ? 'false' : 'true';
        copyBtn.disabled = !next;
      },
    };
  }

  const secCard = makeMetricCard('Unix 秒', () => unixSec);
  const msCard = makeMetricCard('Unix 毫秒', () => unixMs);
  const unixGrid = el('section', 'unix-grid');
  unixGrid.setAttribute('aria-label', 'Unix 时间戳');
  unixGrid.append(secCard.root, msCard.root);

  const zoneCard = el('section', 'card');
  zoneCard.setAttribute('aria-label', '时区转换');
  const zoneHeader = el('div', 'card-header');
  const zoneTitle = el('h2', 'card-title', '时区时间');

  const zoneInput = makeInput('添加时区', 'IANA 时区，如 Asia/Tokyo');
  zoneInput.maxLength = 80;
  const zoneListData = el('datalist');
  zoneListData.id = 'zones';
  zoneInput.setAttribute('list', zoneListData.id);
  for (const zone of Intl.supportedValuesOf?.('timeZone') ?? ['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York']) {
    zoneListData.append(new Option('', zone));
  }
  const zoneShell = el('div', 'input-shell');
  zoneShell.append(zoneInput);
  const addBtn = makeButton('添加', null, 'btn compact', 'plus');
  addBtn.type = 'submit';
  const zoneForm = el('form', 'zone-form');
  zoneForm.append(zoneShell, addBtn, zoneListData);
  zoneForm.addEventListener('submit', event => { event.preventDefault(); void addZone(); });
  zoneHeader.append(zoneTitle, zoneForm);

  const zoneList = el('div', 'zone-list');
  zoneCard.append(zoneHeader, zoneList);
  scroll.append(parseAlert.root, unixGrid, zoneCard);
  workspace.replaceChildren(scroll);

  let zones = [];
  let busy = false;
  let storageAvailable = false;

  source.addEventListener('input', event => { if (!event.isComposing) renderTime(); });
  source.addEventListener('compositionend', renderTime);
  renderTime();

  try {
    zones = savedZones((await readData()).value);
    storageAvailable = true;
    renderTime();
  } catch {
    setStatus('无法读取时区配置；默认时区仍可使用。', 'error');
  }

  function renderTime() {
    clearBtn.hidden = !source.value;
    let date = null;
    let parseError = '';
    try {
      date = parseTime(source.value, currentUnit);
    } catch (error) {
      parseError = error?.message || '时间格式无效。';
    }
    parseAlert.set(parseError);
    if (parseError) sourceShell.dataset.invalid = 'true';
    else delete sourceShell.dataset.invalid;

    unixSec = date ? String(Math.floor(+date / 1000)) : '';
    unixMs = date ? String(+date) : '';
    secCard.update(unixSec);
    msCard.update(unixMs);

    const systemZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const entries = [
      { title: '系统时区', sub: systemZone, zone: undefined, removable: false, copyLabel: `系统时区 · ${systemZone}` },
      { title: 'UTC-0', sub: 'UTC', zone: 'UTC', removable: false, copyLabel: 'UTC-0' },
      ...zones.map(zone => ({ title: zone, sub: '自选时区', zone, removable: true, copyLabel: zone })),
    ];

    zoneList.replaceChildren();
    for (const item of entries) {
      const formatted = date ? formatTime(date, item.zone) : '';
      const row = el('div', 'time-row');
      const meta = el('div', 'time-zone-meta');
      meta.append(el('span', 'time-zone-name', item.title), el('span', 'time-zone-sub', item.sub));
      const val = el('code', 'time-value', formatted || '—');
      val.dataset.empty = formatted ? 'false' : 'true';
      const actions = el('div', 'row-actions');
      const copyBtn = makeCopyButton(item.copyLabel, formatted);
      copyBtn.disabled = !formatted;
      actions.append(copyBtn);
      if (item.removable) {
        const remove = makeButton('', () => changeZone(item.zone, false), 'btn compact ghost icon-only danger-ghost', 'trash');
        remove.disabled = busy || !storageAvailable;
        remove.setAttribute('aria-label', `删除 ${item.zone}`);
        remove.title = `删除 ${item.zone}`;
        actions.append(remove);
      }
      row.append(meta, val, actions);
      zoneList.append(row);
    }

    addBtn.disabled = busy || !storageAvailable;
    zoneInput.disabled = addBtn.disabled;
    setMeta(`自选时区 ${zones.length} / ${maxExtraZones}`);
  }

  async function addZone() {
    if (addBtn.disabled) return;
    try {
      await changeZone(normalizeZone(zoneInput.value), true);
    } catch (error) {
      showError(error);
    }
  }

  async function changeZone(zone, adding) {
    if (busy || !storageAvailable) return;
    busy = true;
    renderTime();
    let message = '';
    let tone = 'ok';
    try {
      const snapshot = await readData();
      zones = savedZones(snapshot.value);
      if (adding && (zone === 'UTC' || zones.includes(zone))) throw new Error('该时区已存在。');
      if (adding && zones.length >= maxExtraZones) throw new Error(`最多可添加 ${maxExtraZones} 个时区。`);
      const next = adding ? [...zones, zone] : zones.filter(item => item !== zone);
      await writeData(snapshot.revision, { zones: next });
      zones = next;
      if (adding) zoneInput.value = '';
      message = '时区配置已保存。';
    } catch (error) {
      message = error?.message || '无法保存时区，请重试。';
      tone = 'error';
    } finally {
      busy = false;
      renderTime();
      setStatus(message, tone);
    }
  }
}

function showBase64() {
  let mode = 'encode';
  let outputText = '';
  let hasError = false;

  const modeSwitch = makeSegmented('Base64 操作', [
    ['encode', '编码'],
    ['decode', '解码'],
  ], 'encode', next => {
    mode = next;
    syncMode();
    convert();
  });

  const swapBtn = makeButton('对调', () => {
    if (!outputText || hasError) return;
    input.value = outputText;
    const next = mode === 'encode' ? 'decode' : 'encode';
    mode = next;
    modeSwitch.setValue(next);
    syncMode();
    convert();
    input.focus?.();
  }, 'btn', 'swap');
  swapBtn.title = '将结果填入输入并切换模式';

  const clearBtn = makeButton('清空', () => {
    input.value = '';
    convert();
    input.focus?.();
  }, 'btn', 'clear');

  const rightGroup = el('div', 'toolbar-group');
  rightGroup.append(swapBtn, clearBtn);
  toolbar.hidden = false;
  toolbar.replaceChildren(modeSwitch.root, rightGroup);

  const panes = el('div', 'split-panes');

  const leftPane = el('section', 'pane');
  const leftHead = el('div', 'pane-head');
  const leftLabel = el('label', 'pane-label', '原文');
  leftLabel.setAttribute('for', 'base64-input');
  const inCount = el('span', 'badge mono', '0 字节');
  leftHead.append(leftLabel, inCount);
  const input = makeTextarea('base64-input', '输入内容', '输入要编码的 UTF-8 文本');
  leftPane.append(leftHead, input);

  const rightPane = el('section', 'pane');
  const rightHead = el('div', 'pane-head');
  const rightLabel = el('span', 'pane-label', 'Base64 结果');
  const rightActions = el('div', 'pane-actions');
  const outCount = el('span', 'badge mono', '0 字节');
  const copyBtn = makeCopyButton('转换结果', () => outputText);
  rightActions.append(outCount, copyBtn);
  rightHead.append(rightLabel, rightActions);

  const rightBody = el('div', 'pane-body');
  const output = el('pre', 'code-output');
  output.tabIndex = 0;
  output.setAttribute('aria-label', '转换结果');
  const emptyState = el('div', 'pane-empty', '输入内容后自动转换');
  const errorWrap = el('div', 'pane-error-wrap');
  const errorAlert = makeAlert();
  errorWrap.append(errorAlert.root);
  rightBody.append(output, emptyState, errorWrap);
  rightPane.append(rightHead, rightBody);

  panes.append(leftPane, rightPane);
  workspace.replaceChildren(panes);

  function syncMode() {
    const encoding = mode === 'encode';
    leftLabel.textContent = encoding ? '原文' : 'Base64 输入';
    rightLabel.textContent = encoding ? 'Base64 结果' : '解码文本';
    input.placeholder = encoding ? '输入要编码的 UTF-8 文本' : '输入标准或 URL-safe Base64';
    input.maxLength = encoding ? textBudget : base64Budget * 2;
    setMeta(encoding ? 'UTF-8 · 上限 64 KiB' : 'UTF-8 · 支持 URL-safe Base64');
  }

  function convert() {
    setStatus('');
    const raw = input.value;
    inCount.textContent = `${byteLength(raw).toLocaleString()} 字节`;
    clearBtn.disabled = !raw.length;

    if (!raw) {
      outputText = '';
      hasError = false;
      output.textContent = '';
      output.hidden = true;
      errorWrap.hidden = true;
      emptyState.textContent = '输入内容后自动转换';
      emptyState.hidden = false;
      outCount.textContent = '0 字节';
      copyBtn.disabled = true;
      swapBtn.disabled = true;
      return;
    }

    try {
      outputText = (mode === 'encode' ? encodeBase64 : decodeBase64)(raw);
      hasError = false;
      output.textContent = outputText;
      output.hidden = !outputText;
      errorWrap.hidden = true;
      emptyState.textContent = outputText ? '输入内容后自动转换' : '结果为空';
      emptyState.hidden = !!outputText;
      outCount.textContent = `${byteLength(outputText).toLocaleString()} 字节`;
      copyBtn.disabled = !outputText;
      swapBtn.disabled = !outputText;
    } catch (error) {
      outputText = '';
      hasError = true;
      output.textContent = '';
      output.hidden = true;
      emptyState.hidden = true;
      errorAlert.set(error?.message || '转换失败，请检查输入。');
      errorWrap.hidden = false;
      outCount.textContent = '0 字节';
      copyBtn.disabled = true;
      swapBtn.disabled = true;
    }
  }

  input.addEventListener('input', event => { if (!event.isComposing) convert(); });
  input.addEventListener('compositionend', convert);
  document.addEventListener('keydown', event => {
    if (!event.defaultPrevented && !event.isComposing && !event.repeat && !event.altKey && !event.shiftKey &&
        event.ctrlKey !== event.metaKey && event.key === 'Enter' && outputText && !hasError) {
      event.preventDefault();
      copyBtn.click();
    }
  });

  syncMode();
  convert();
}

function showHash() {
  let uppercase = false;
  const digests = Object.fromEntries(Object.keys(hashAlgorithms).map(name => [name, '']));

  const caseSwitch = makeSegmented('摘要大小写', [
    ['lower', '小写 hex'],
    ['upper', '大写 HEX'],
  ], 'lower', next => {
    uppercase = next === 'upper';
    compute();
  });

  const clearBtn = makeButton('清空', () => {
    input.value = '';
    compute();
    input.focus?.();
  }, 'btn', 'clear');

  toolbar.hidden = false;
  toolbar.replaceChildren(caseSwitch.root, clearBtn);

  const container = el('div', 'hash-workspace');
  const inputPane = el('section', 'hash-input-pane');
  const inputHead = el('div', 'pane-head');
  const inputLabel = el('label', 'pane-label', '输入文本');
  inputLabel.setAttribute('for', 'hash-input');
  const byteBadge = el('span', 'badge mono', '0 / 65,536 字节');
  inputHead.append(inputLabel, byteBadge);
  const input = makeTextarea('hash-input', '输入内容', '输入或粘贴文本，实时计算全部摘要');
  input.maxLength = textBudget;
  inputPane.append(inputHead, input);

  const listWrap = el('div', 'hash-list-wrap scroller');
  const hashAlert = makeAlert();
  hashAlert.set('');
  const card = el('section', 'card');
  card.setAttribute('aria-label', '摘要结果');

  const rows = [];
  const copyButtons = [];
  const names = Object.keys(hashAlgorithms);
  names.forEach((name, index) => {
    const row = el('div', 'hash-row');
    const meta = el('div', 'hash-meta');
    meta.append(
      el('span', 'hash-name', name),
      el('span', 'hash-bits', `${HASH_BITS[name]} bit`),
    );
    const codeEl = el('code', 'hash-digest');
    const actions = el('div', 'row-actions');
    const key = index + 1;
    const kbd = el('kbd', 'kbd', `${shortcutPrefix}${key}`);
    const copyBtn = makeCopyButton(name, () => digests[name]);
    copyBtn.title = `Cmd/Ctrl + ${key}`;
    copyBtn.setAttribute('aria-keyshortcuts', `Meta+${key} Control+${key}`);
    actions.append(kbd, copyBtn);
    row.append(meta, codeEl, actions);
    card.append(row);
    rows.push({ name, codeEl, copyBtn });
    copyButtons.push(copyBtn);
  });

  listWrap.append(hashAlert.root, card);
  container.append(inputPane, listWrap);
  workspace.replaceChildren(container);

  function compute() {
    setStatus('');
    const raw = input.value;
    const bytes = byteLength(raw);
    byteBadge.textContent = `${bytes.toLocaleString()} / ${textBudget.toLocaleString()} 字节`;
    clearBtn.disabled = !raw.length;

    let errorMessage = '';
    for (const name of names) {
      try {
        const value = hashText(raw, name);
        digests[name] = uppercase ? value.toUpperCase() : value;
      } catch (error) {
        digests[name] = '';
        errorMessage = error?.message || '计算失败。';
      }
    }
    hashAlert.set(errorMessage);
    for (const { name, codeEl, copyBtn } of rows) {
      const value = digests[name];
      codeEl.textContent = value || '—';
      codeEl.dataset.empty = value ? 'false' : 'true';
      copyBtn.disabled = !value;
    }
    setMeta(raw ? `${shortcutPrefix}1–5 复制` : `空文本摘要 · ${shortcutPrefix}1–5 复制`);
  }

  input.addEventListener('input', event => { if (!event.isComposing) compute(); });
  input.addEventListener('compositionend', compute);
  bindNumberShortcuts(names.length, index => copyButtons[index]);
  compute();
}

function showUUID() {
  const leftGroup = el('div', 'toolbar-group');
  leftGroup.append(el('span', 'badge accent mono', 'UUID v4'), el('span', 'badge', '128-bit 随机'));
  const regenerateBtn = makeButton('重新生成', generate, 'btn primary', 'refresh');
  toolbar.hidden = false;
  toolbar.replaceChildren(leftGroup, regenerateBtn);

  const scroll = el('div', 'workspace-scroll uuid-workspace scroller');
  const card = el('section', 'card uuid-card');
  card.setAttribute('aria-label', 'UUID 形态');
  scroll.append(card);
  workspace.replaceChildren(scroll);

  let copies = [];
  bindNumberShortcuts(4, index => copies[index]);
  setMeta(`${shortcutPrefix}1–4 复制`);

  function generate() {
    setStatus('');
    try {
      const entries = Object.entries(uuidForms());
      copies = [];
      const rows = entries.map(([label, value], index) => {
        const row = el('div', 'uuid-row');
        const meta = el('div', 'uuid-meta');
        meta.append(
          el('span', 'uuid-label', label),
          el('span', 'badge mono', `${value.length} 字符`),
        );
        const codeEl = el('code', 'uuid-value', value);
        const actions = el('div', 'row-actions');
        const key = index + 1;
        const kbd = el('kbd', 'kbd', `${shortcutPrefix}${key}`);
        const copyBtn = makeCopyButton(label, value);
        copyBtn.title = `Cmd/Ctrl + ${key}`;
        copyBtn.setAttribute('aria-keyshortcuts', `Meta+${key} Control+${key}`);
        copies.push(copyBtn);
        actions.append(kbd, copyBtn);
        row.append(meta, codeEl, actions);
        return row;
      });
      card.replaceChildren(...rows);
    } catch (error) {
      showError(error);
    }
  }

  generate();
}

function showQR(launch) {
  let mode = launch.image ? 'decode' : 'encode';
  let decodedText = '';
  let scanning = false;
  let hasPreview = false;

  const modeTabs = makeSegmented('二维码模式', [
    ['encode', '编码'],
    ['decode', '解码'],
  ], mode, next => {
    mode = next;
    syncMode();
  }, true);

  const clearBtn = makeButton('清空', () => {
    source.value = '';
    encode();
    source.focus?.();
  }, 'btn', 'clear');
  const copySourceBtn = makeCopyButton('输入文本', () => source.value, false);
  const chooseBtn = makeButton('选择图片', () => scan(openImage), 'btn primary', 'image');
  const pasteBtn = makeButton('读取剪贴板', () => scan(readClipboardImage), 'btn', 'paste');

  const actionGroup = el('div', 'toolbar-group');
  actionGroup.append(clearBtn, copySourceBtn, chooseBtn, pasteBtn);
  toolbar.hidden = false;
  toolbar.replaceChildren(modeTabs.root, actionGroup);

  // Encode Tab Panel
  const encodePanel = el('div', 'split-panes qr-encode-panes');
  encodePanel.setAttribute('role', 'tabpanel');
  encodePanel.setAttribute('aria-label', '二维码编码');

  const encodeLeft = el('section', 'pane');
  const encodeHead = el('div', 'pane-head');
  const encodeLabel = el('label', 'pane-label', '文本或网址');
  encodeLabel.setAttribute('for', 'qr-input');
  const byteBadge = el('span', 'badge mono', '0 / 2,300 字节');
  encodeHead.append(encodeLabel, byteBadge);
  const source = makeTextarea('qr-input', '二维码内容', '输入文本或 https:// 网址，实时生成二维码');
  source.maxLength = 2300;
  encodeLeft.append(encodeHead, source);

  const stage = el('section', 'qr-stage');
  stage.setAttribute('aria-label', '二维码预览');
  const qrCard = el('div', 'qr-card');
  const qrSpec = el('span', 'badge mono');
  const qrEmpty = el('div', 'qr-empty');
  qrEmpty.append(svgIcon('qr'), el('span', '', '输入内容即可生成二维码'));
  const qrErrorWrap = el('div', 'pane-error-wrap');
  const qrErrorAlert = makeAlert();
  qrErrorWrap.append(qrErrorAlert.root);
  stage.append(qrCard, qrSpec, qrEmpty, qrErrorWrap);
  encodePanel.append(encodeLeft, stage);

  // Decode Tab Panel
  const decodePanel = el('div', 'workspace');
  decodePanel.setAttribute('role', 'tabpanel');
  decodePanel.setAttribute('aria-label', '二维码解码');

  const dropzoneWrap = el('div', 'qr-dropzone-wrap');
  const dropzone = el('div', 'qr-dropzone');
  const dropIcon = el('div', 'qr-drop-icon');
  dropIcon.append(svgIcon('qr'));
  const dropTitle = el('p', 'qr-drop-title', '选择或粘贴包含二维码的图片');
  const dropActions = el('div', 'qr-drop-actions');
  const dropChoose = makeButton('选择图片', () => scan(openImage), 'btn primary', 'image');
  const dropPaste = makeButton('读取剪贴板图片', () => scan(readClipboardImage), 'btn', 'paste');
  dropActions.append(dropChoose, dropPaste);
  const dropHint = el('div', 'qr-drop-hint');
  dropHint.append(el('kbd', 'kbd', `${shortcutPrefix}V`), el('span', '', '直接粘贴剪贴板图片'));
  dropzone.append(dropIcon, dropTitle, dropActions, dropHint);
  dropzoneWrap.append(dropzone);

  const decodePanes = el('div', 'split-panes');
  const previewPane = el('section', 'pane');
  const previewHead = el('div', 'pane-head');
  const dimBadge = el('span', 'badge mono');
  previewHead.append(el('span', 'pane-label', '原图预览'), dimBadge);
  const previewBox = el('div', 'qr-preview-box');
  const preview = el('img', 'preview');
  preview.alt = '待识别的二维码图片';
  previewBox.append(preview);
  previewPane.append(previewHead, previewBox);

  const decodeOutPane = el('section', 'pane');
  const decodeOutHead = el('div', 'pane-head');
  const copyResultBtn = makeCopyButton('识别结果', () => decodedText);
  decodeOutHead.append(el('span', 'pane-label', '识别结果'), copyResultBtn);
  const decodeOutBody = el('div', 'pane-body');
  const decodeOutput = el('pre', 'code-output');
  decodeOutput.tabIndex = 0;
  decodeOutput.setAttribute('aria-label', '识别结果');
  const decodeEmpty = el('div', 'pane-empty');
  const decodeErrWrap = el('div', 'pane-error-wrap');
  const decodeErrAlert = makeAlert();
  decodeErrWrap.append(decodeErrAlert.root);
  decodeOutBody.append(decodeOutput, decodeEmpty, decodeErrWrap);
  decodeOutPane.append(decodeOutHead, decodeOutBody);
  decodePanes.append(previewPane, decodeOutPane);

  decodePanel.append(dropzoneWrap, decodePanes);
  workspace.replaceChildren(encodePanel, decodePanel);

  function syncMode() {
    const decoding = mode === 'decode';
    encodePanel.hidden = decoding;
    decodePanel.hidden = !decoding;
    clearBtn.hidden = decoding;
    copySourceBtn.hidden = decoding;
    chooseBtn.hidden = !decoding;
    pasteBtn.hidden = !decoding;
    dropzoneWrap.hidden = hasPreview;
    decodePanes.hidden = !hasPreview;
    setMeta(decoding ? `${shortcutPrefix}V 粘贴图片` : '上限 2,300 字节 · 纠错等级 M');
  }

  function encode() {
    setStatus('');
    const text = source.value;
    const bytes = byteLength(text);
    byteBadge.textContent = `${bytes.toLocaleString()} / 2,300 字节`;
    clearBtn.disabled = !text.length;
    copySourceBtn.disabled = !text.length;

    if (!text.length) {
      qrCard.hidden = true;
      qrSpec.hidden = true;
      qrErrorWrap.hidden = true;
      qrEmpty.hidden = false;
      return;
    }

    try {
      const qr = encodeQR(text);
      const canvas = el('canvas', 'qr-canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', '生成的二维码');
      const count = qr.getModuleCount();
      const scale = Math.max(4, Math.floor(448 / (count + 8)));
      canvas.width = canvas.height = (count + 8) * scale;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000';
      for (let row = 0; row < count; row++) {
        for (let column = 0; column < count; column++) {
          if (qr.isDark(row, column)) context.fillRect((column + 4) * scale, (row + 4) * scale, scale, scale);
        }
      }
      qrCard.replaceChildren(canvas);
      qrSpec.textContent = `${count} × ${count} 模块 · 纠错 M`;
      qrCard.hidden = false;
      qrSpec.hidden = false;
      qrEmpty.hidden = true;
      qrErrorWrap.hidden = true;
    } catch (error) {
      qrCard.hidden = true;
      qrSpec.hidden = true;
      qrEmpty.hidden = true;
      qrErrorAlert.set(error?.message || '二维码生成失败。');
      qrErrorWrap.hidden = false;
    }
  }

  function showDecodeState({ text = '', emptyMessage = '', errorMessage = '' }) {
    decodedText = text;
    decodeOutput.textContent = text;
    decodeOutput.hidden = !text;
    copyResultBtn.disabled = !text;
    decodeEmpty.textContent = emptyMessage;
    decodeEmpty.hidden = !emptyMessage;
    decodeErrAlert.set(errorMessage);
    decodeErrWrap.hidden = !errorMessage;
  }

  async function scan(getImage) {
    if (scanning) return;
    scanning = true;
    modeTabs.setDisabled(true);
    chooseBtn.disabled = pasteBtn.disabled = dropChoose.disabled = dropPaste.disabled = true;
    setStatus('正在读取图片…');
    let loadedNewImage = false;
    try {
      const snapshot = await getImage();
      if (!snapshot) {
        setStatus(getImage === readClipboardImage ? '剪贴板中没有图片。' : '');
        return;
      }
      loadedNewImage = true;
      hasPreview = true;
      preview.src = snapshot.url;
      dimBadge.textContent = '解析中';
      showDecodeState({ emptyMessage: '正在识别二维码…' });
      syncMode();
      await preview.decode();
      dimBadge.textContent = `${preview.naturalWidth} × ${preview.naturalHeight}`;
      const scale = Math.min(1, 2048 / Math.max(preview.naturalWidth, preview.naturalHeight));
      const canvas = el('canvas');
      canvas.width = Math.max(1, Math.round(preview.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(preview.naturalHeight * scale));
      const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(preview, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const decoded = decodeQR(pixels.data, pixels.width, pixels.height);
      if (decoded) {
        showDecodeState({ text: decoded });
        setStatus('识别完成。', 'ok');
      } else {
        showDecodeState({ emptyMessage: '二维码不包含可显示的文本。' });
        setStatus('二维码不包含可显示的文本。');
      }
    } catch (error) {
      const message = error?.message || '无法识别二维码。';
      if (loadedNewImage) {
        showDecodeState({ errorMessage: message });
        if (dimBadge.textContent === '解析中') dimBadge.textContent = '加载失败';
      }
      setStatus(message, 'error');
    } finally {
      scanning = false;
      modeTabs.setDisabled(false);
      chooseBtn.disabled = pasteBtn.disabled = dropChoose.disabled = dropPaste.disabled = false;
    }
  }

  source.addEventListener('input', event => { if (!event.isComposing) encode(); });
  source.addEventListener('compositionend', encode);
  document.addEventListener('paste', event => {
    if (mode === 'decode' && Array.from(event.clipboardData?.types ?? []).includes('Files')) {
      event.preventDefault();
      void scan(readClipboardImage);
    }
  });
  document.addEventListener('keydown', event => {
    if (mode !== 'decode' || event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey ||
        event.ctrlKey === event.metaKey || event.key.toLowerCase() !== 'v') return;
    event.preventDefault();
    void scan(readClipboardImage);
  });

  syncMode();
  if (launch.image) {
    void scan(() => launch.image);
  } else {
    if (launch.input) source.value = launch.input.trim();
    encode();
  }
}

async function start() {
  ready();
  const launch = await readLaunch();
  switch (launch.commandId) {
    case 'time': await showTime(launch.input); break;
    case 'base64': showBase64(); break;
    case 'hash': showHash(); break;
    case 'uuid': showUUID(); break;
    case 'qr': showQR(launch); break;
    default: throw new Error('请从司南搜索结果打开工具。');
  }
}

start().catch(showError);
