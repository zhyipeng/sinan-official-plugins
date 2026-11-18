import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseTime, formatTime, normalizeZone, savedZones, maxExtraZones, textBudget,
  encodeBase64, decodeBase64, hashText, hashAlgorithms, uuidForms, encodeQR, decodeQR} from '../ui/tools.js';

test('秒和毫秒、零、负值与显式单位', () => {
  assert.equal(+parseTime('1700000000'), 1700000000000);
  assert.equal(+parseTime(' 1700000000321 '), 1700000000321);
  assert.equal(+parseTime('0'), 0);
  assert.equal(+parseTime('-1'), -1000);
  assert.equal(+parseTime('-1', 'millis'), -1);
  assert.equal(+parseTime('10000000000', 'seconds'), 10000000000000);
  assert.equal(parseTime(' '), null);
  assert.throws(() => parseTime('99999999999999999999'), /超出范围/);
});

test('严格日期、显式偏移与系统本地时间', () => {
  assert.equal(parseTime('2024-02-29T00:00:00.25+08:00').toISOString(), '2024-02-28T16:00:00.250Z');
  assert.equal(parseTime('2024-01-01T00:00-0530').toISOString(), '2024-01-01T05:30:00.000Z');
  assert.equal(+parseTime('2024/2/29 12:34'), +new Date(2024, 1, 29, 12, 34));
  assert.equal(+parseTime('2024-01-01 00:00Z'), Date.UTC(2024, 0, 1));
  for (const invalid of ['2023-02-29', '2024-02-30 00:00Z', '2024-04-31', '2024-09-01T24:00Z', '2024-01-01 00:00+2461']) {
    assert.throws(() => parseTime(invalid), /无效/);
  }
});

test('时区格式使用日期对应的夏令时与非整点偏移；配置有界去重', () => {
  assert.equal(formatTime(new Date(0), 'UTC'), '1970-01-01 00:00:00.000 UTC+00:00');
  assert.equal(formatTime(parseTime('0000-01-01 00:00Z'), 'UTC'), '0000-01-01 00:00:00.000 UTC+00:00');
  assert.match(formatTime(parseTime('2024-07-01T12:00Z'), 'America/New_York'), /08:00:00\.000 UTC-04:00$/);
  assert.match(formatTime(parseTime('2024-01-01T12:00Z'), 'America/New_York'), /07:00:00\.000 UTC-05:00$/);
  assert.match(formatTime(parseTime('2024-01-01T12:00Z'), 'Asia/Kolkata'), /17:30:00\.000 UTC\+05:30$/);
  assert.equal(normalizeZone(' asia/tokyo '), 'Asia/Tokyo');
  assert.throws(() => normalizeZone('NoSuch/Zone'), /找不到/);
  assert.deepEqual(savedZones({zones: ['UTC', 'Asia/Tokyo', 'asia/tokyo', 42, 'NoSuch/Zone']}), ['Asia/Tokyo']);
  assert.deepEqual(savedZones({zones: [...Array(maxExtraZones).fill(null), 'Asia/Tokyo']}), []);
});

test('Base64 往返 UTF-8（含 BOM）、URL 安全输入与无效字节', () => {
  for (const text of ['', 'hello', '\ufeff司南 🔧\n', 'a'.repeat(textBudget)]) {
    assert.equal(encodeBase64(text), Buffer.from(text).toString('base64'));
    assert.equal(decodeBase64(encodeBase64(text)), text);
  }
  assert.equal(decodeBase64(' 8J-\nYgA '), '😀');
  assert.throws(() => decodeBase64('%%'), /Base64/);
  assert.throws(() => decodeBase64('/w=='), /UTF-8/);
  assert.throws(() => encodeBase64('汉'.repeat(textBudget / 2)), /64 KiB/);
});

test('Hash 算法与 Node 独立实现一致', () => {
  for (const algorithm of Object.keys(hashAlgorithms)) {
    for (const text of ['', 'abc', '编码助手 🔧']) {
      assert.equal(hashText(text, algorithm), createHash(algorithm.replace('-', '').toLowerCase()).update(text).digest('hex'));
    }
  }
  assert.throws(() => hashText('abc', 'toString'), /不支持/);
});

test('UUID 四种形态源于同一个随机值，版本和变体正确', () => {
  const result = uuidForms({getRandomValues: bytes => bytes.fill(255)});
  assert.deepEqual(result, {
    '标准格式': 'ffffffff-ffff-4fff-bfff-ffffffffffff',
    '无连字符': 'ffffffffffff4fffbfffffffffffffff',
    '全大写': 'FFFFFFFF-FFFF-4FFF-BFFF-FFFFFFFFFFFF',
    '全小写': 'ffffffff-ffff-4fff-bfff-ffffffffffff',
  });
  assert.notEqual(uuidForms()['标准格式'], uuidForms()['标准格式']);
});

function rgba(code, inverted = false) {
  const count = code.getModuleCount(), scale = 5, size = (count + 8) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / scale) - 4, column = Math.floor(x / scale) - 4;
      const dark = row >= 0 && column >= 0 && row < count && column < count && code.isDark(row, column);
      const color = dark !== inverted ? 0 : 255, offset = (y * size + x) * 4;
      pixels.set([color, color, color, 255], offset);
    }
  }
  return [pixels, size, size];
}

test('二维码可离线往返 ASCII、Unicode 和反色图片', () => {
  for (const text of ['https://example.test/path?value=1', '司南 🔧', 'x'.repeat(2300)]) {
    assert.equal(decodeQR(...rgba(encodeQR(text))), text);
  }
  assert.equal(decodeQR(...rgba(encodeQR('反色'), true)), '反色');
  assert.throws(() => encodeQR(''), /输入/);
  assert.throws(() => encodeQR('字'.repeat(800)), /2300/);
  assert.throws(() => decodeQR(new Uint8ClampedArray(64 * 64 * 4), 64, 64), /未找到/);
});

test('五个普通入口，只有时间和二维码声明内容匹配', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.runtime, {kind: 'declarative'});
  assert.deepEqual(manifest.permissions, []);
  const commands = manifest.contributes.commands;
  assert.deepEqual(commands.map(command => command.id), ['time', 'base64', 'uuid', 'hash', 'qr']);
  assert.deepEqual(commands.filter(command => command.inputMatchers).map(command => command.id), ['time', 'qr']);
  assert.deepEqual(commands[4].inputMatchers.map(matcher => matcher.kind), ['regex', 'image']);
});
