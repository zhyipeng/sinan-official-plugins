import {ready, readLaunch, readData, writeData, writeClipboardText, readClipboardImage, openImage} from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';
import {parseTime, formatTime, normalizeZone, savedZones, maxExtraZones, textBudget, base64Budget,
  encodeBase64, decodeBase64, hashText, hashAlgorithms, uuidForms, encodeQR, decodeQR} from './tools.js';

const title = document.querySelector('#title');
const actions = document.querySelector('#actions');
const status = document.querySelector('#status');
const panel = document.querySelector('#panel');

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function button(text, onClick, className = '') {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function field(tag, name, placeholder = '') {
  const node = element(tag);
  node.setAttribute('aria-label', name);
  node.placeholder = placeholder;
  node.spellcheck = false;
  node.autocomplete = 'off';
  return node;
}

function select(name, options) {
  const node = element('select');
  node.setAttribute('aria-label', name);
  for (const [value, label] of options) node.add(new Option(label, value));
  return node;
}

function notice(message = '', error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function showError(error) {
  notice(error?.message || '操作失败，请重试。', true);
}

function copyButton(label, value) {
  const copy = button('复制', async () => {
    copy.disabled = true;
    try {
      await writeClipboardText(value);
      notice(`已复制${label}。`);
    } catch {
      notice('无法写入剪贴板，或结果超过剪贴板限额。可选中结果手动复制。', true);
    } finally { copy.disabled = false; }
  });
  copy.setAttribute('aria-label', `复制${label}`);
  return copy;
}

function resultRow(label, value, remove) {
  const row = element('div', '', 'result');
  const content = element('div', '', 'result-content');
  content.append(element('span', label, 'caption'), element('code', value));
  row.append(content);
  if (value) row.append(copyButton(label, value));
  if (remove) row.append(remove);
  return row;
}

async function showTime(input) {
  title.textContent = '时间转换';
  const source = field('input', '时间输入', '时间戳或时间字符串');
  source.maxLength = 96;
  source.value = input ?? String(Date.now());
  const unit = select('时间戳单位', [['auto', '自动'], ['seconds', '秒'], ['millis', '毫秒']]);
  const now = button('现在', () => {
    unit.value = 'millis';
    source.value = String(Date.now());
    renderTime();
  });
  const controls = element('div', '', 'controls');
  controls.append(source, unit, now);
  const results = element('section', '', 'results');
  results.setAttribute('aria-label', '转换结果');
  const zoneInput = field('input', '添加时区', 'IANA 时区，例如 Asia/Tokyo');
  zoneInput.maxLength = 80;
  const add = button('添加时区', addZone);
  const form = element('form', '', 'controls');
  const list = element('datalist');
  list.id = 'zones';
  zoneInput.setAttribute('list', list.id);
  for (const zone of Intl.supportedValuesOf?.('timeZone') ?? ['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York']) {
    list.append(new Option('', zone));
  }
  form.append(zoneInput, add, list);
  form.addEventListener('submit', event => { event.preventDefault(); void addZone(); });
  panel.append(controls, results, form);

  let zones = [];
  let busy = false, storageAvailable = false;
  source.addEventListener('input', event => { if (!event.isComposing) renderTime(); });
  source.addEventListener('compositionend', renderTime);
  unit.addEventListener('change', renderTime);
  renderTime();
  try {
    zones = savedZones((await readData()).value);
    storageAvailable = true;
    renderTime();
  } catch { notice('无法读取时区配置；默认时区仍可使用。', true); }

  function renderTime() {
    let date;
    notice();
    try { date = parseTime(source.value, unit.value); }
    catch (error) { showError(error); }
    const system = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const rows = [[`系统时区 · ${system}`, undefined], ['UTC-0', 'UTC'], ...zones.map(zone => [zone, zone, true])];
    results.replaceChildren();
    for (const [label, zone, removable] of rows) {
      const remove = removable ? button('删除', () => changeZone(zone, false)) : null;
      if (remove) {
        remove.disabled = busy || !storageAvailable;
        remove.setAttribute('aria-label', `删除 ${zone}`);
      }
      results.append(resultRow(label, date ? formatTime(date, zone) : '', remove));
    }
    if (date) results.append(resultRow('Unix 秒', String(Math.floor(+date / 1000))), resultRow('Unix 毫秒', String(+date)));
    add.disabled = busy || !storageAvailable;
    zoneInput.disabled = add.disabled;
  }

  async function addZone() {
    if (add.disabled) return;
    try { await changeZone(normalizeZone(zoneInput.value), true); }
    catch (error) { showError(error); }
  }

  async function changeZone(zone, adding) {
    if (busy || !storageAvailable) return;
    busy = true;
    renderTime();
    let message = '', failed = false;
    try {
      const snapshot = await readData();
      zones = savedZones(snapshot.value);
      if (adding && (zone === 'UTC' || zones.includes(zone))) throw new Error('该时区已存在。');
      if (adding && zones.length >= maxExtraZones) throw new Error(`最多可添加 ${maxExtraZones} 个时区。`);
      const next = adding ? [...zones, zone] : zones.filter(item => item !== zone);
      await writeData(snapshot.revision, {zones: next});
      zones = next;
      if (adding) zoneInput.value = '';
      message = '时区配置已保存。';
    } catch (error) {
      message = error?.message || '无法保存时区，请重试。';
      failed = true;
    } finally {
      busy = false;
      renderTime();
      notice(message, failed);
    }
  }
}

function showText(command) {
  const hash = command === 'hash';
  title.textContent = hash ? 'Hash 计算' : 'Base64 编码 / 解码';
  const source = field('textarea', '输入内容', hash ? '输入要计算的文本' : '输入文本或 Base64');
  source.maxLength = hash ? textBudget : base64Budget * 2;
  const result = element('div');
  const mode = hash
    ? select('Hash 算法', Object.keys(hashAlgorithms).map(name => [name, name]))
    : select('Base64 操作', [['encode', '编码'], ['decode', '解码']]);
  if (hash) mode.value = 'SHA-256';
  actions.append(mode, button(hash ? '计算' : '转换', convert, 'primary'));
  panel.append(source, result);
  for (const node of [source, mode]) node.addEventListener(node === source ? 'input' : 'change', () => {
    result.replaceChildren();
    notice();
  });
  function convert() {
    notice();
    result.replaceChildren();
    try {
      const value = hash ? hashText(source.value, mode.value) : (mode.value === 'encode' ? encodeBase64 : decodeBase64)(source.value);
      result.append(resultRow(hash ? mode.value : '转换结果', value));
      if (!value) notice('结果为空。');
    } catch (error) { showError(error); }
  }
}

function showUUID() {
  title.textContent = '生成 UUID';
  actions.append(button('重新生成', generate, 'primary'));
  let copies = [];
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey ||
        event.ctrlKey === event.metaKey || !/^[1-4]$/.test(event.key)) return;
    const copy = copies[Number(event.key) - 1];
    if (!copy) return;
    event.preventDefault();
    copy.click();
  });
  function generate() {
    notice();
    try {
      const rows = Object.entries(uuidForms()).map(([label, value]) => resultRow(label, value));
      copies = rows.map((row, index) => {
        const copy = row.lastElementChild;
        const key = index + 1;
        copy.title = `Cmd/Ctrl + ${key}`;
        copy.setAttribute('aria-keyshortcuts', `Meta+${key} Control+${key}`);
        return copy;
      });
      panel.replaceChildren(...rows);
    } catch (error) { showError(error); }
  }
  generate();
}

function showQR(launch) {
  title.textContent = '二维码';
  const section = element('section');
  const source = field('textarea', '二维码内容', '输入文本或网址');
  source.maxLength = 2300;
  const result = element('div');
  const mode = select('二维码操作', [['encode', '编码'], ['decode', '解码']]);
  if (launch.image) mode.value = 'decode';
  const generate = button('生成', encode, 'primary');
  const choose = button('选择图片', () => scan(openImage), 'primary');
  const paste = button('读取剪贴板图片', () => scan(readClipboardImage));
  const preview = element('img', '', 'preview');
  preview.alt = '待识别的二维码图片';
  preview.hidden = true;
  const empty = element('p', '选择图片，或粘贴包含二维码的图片。', 'caption');
  section.append(source, empty, preview, result);
  actions.append(mode, generate, choose, paste);
  panel.append(section);
  source.addEventListener('input', () => { result.replaceChildren(); notice(); });
  mode.addEventListener('change', () => { switchMode(); result.replaceChildren(); notice(); });
  document.addEventListener('paste', event => {
    if (mode.value === 'decode' && Array.from(event.clipboardData?.types ?? []).includes('Files')) {
      event.preventDefault();
      void scan(readClipboardImage);
    }
  });
  document.addEventListener('keydown', event => {
    if (mode.value !== 'decode' || event.isComposing || event.repeat || event.altKey || event.shiftKey ||
        !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'v') return;
    event.preventDefault();
    void scan(readClipboardImage);
  });
  switchMode();
  if (launch.image) void scan(() => launch.image);
  else if (launch.input) { source.value = launch.input.trim(); encode(); }

  function switchMode() {
    const decoding = mode.value === 'decode';
    source.hidden = generate.hidden = decoding;
    choose.hidden = paste.hidden = !decoding;
    preview.hidden = !decoding || !preview.hasAttribute('src');
    empty.hidden = !decoding || !preview.hidden;
  }

  function encode() {
    result.replaceChildren();
    notice();
    try {
      const qr = encodeQR(source.value);
      const canvas = element('canvas', '', 'qr');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', '生成的二维码');
      const count = qr.getModuleCount(), scale = Math.max(2, Math.floor(288 / (count + 8)));
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
      result.append(canvas);
    } catch (error) { showError(error); }
  }

  async function scan(getImage) {
    if (mode.disabled) return;
    mode.disabled = choose.disabled = paste.disabled = true;
    notice('正在读取图片…');
    try {
      const snapshot = await getImage();
      if (!snapshot) { notice(getImage === readClipboardImage ? '剪贴板中没有图片。' : ''); return; }
      result.replaceChildren();
      preview.src = snapshot.url;
      switchMode();
      await preview.decode();
      const scale = Math.min(1, 2048 / Math.max(preview.naturalWidth, preview.naturalHeight));
      const canvas = element('canvas');
      canvas.width = Math.max(1, Math.round(preview.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(preview.naturalHeight * scale));
      const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(preview, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const decoded = decodeQR(pixels.data, pixels.width, pixels.height);
      result.append(resultRow('识别结果', decoded));
      notice(decoded ? '' : '二维码不包含可显示的文本。');
    } catch (error) { showError(error); }
    finally { mode.disabled = choose.disabled = paste.disabled = false; }
  }
}

async function start() {
  ready();
  const launch = await readLaunch();
  switch (launch.commandId) {
    case 'time': await showTime(launch.input); break;
    case 'base64': case 'hash': showText(launch.commandId); break;
    case 'uuid': showUUID(); break;
    case 'qr': showQR(launch); break;
    default: throw new Error('请从司南搜索结果打开工具。');
  }
}

start().catch(showError);
