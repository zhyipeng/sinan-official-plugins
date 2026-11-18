import {md5, sha1} from '@noble/hashes/legacy.js';
import {sha256, sha384, sha512} from '@noble/hashes/sha2.js';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';

const encoder = new TextEncoder();
const datePattern = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?: ?(Z|[+-]\d{2}:?\d{2}))?)?$/i;
export const maxExtraZones = 24;
export const textBudget = 64 * 1024;
export const base64Budget = Math.ceil(textBudget / 3) * 4;
export const hashAlgorithms = {'MD5': md5, 'SHA-1': sha1, 'SHA-256': sha256, 'SHA-384': sha384, 'SHA-512': sha512};

export function parseTime(input, unit = 'auto') {
  const text = input.trim();
  if (!text) return null;
  if (/^[+-]?\d+$/.test(text)) {
    const seconds = unit === 'seconds' || (unit === 'auto' && text.replace(/^[+-]/, '').length <= 10);
    const date = new Date(Number(text) * (seconds ? 1000 : 1));
    if (!Number.isNaN(date.getTime())) return date;
    throw new Error('时间戳超出范围。');
  }
  const parts = datePattern.exec(text);
  if (!parts) throw new Error('请输入秒/毫秒时间戳，或 YYYY-MM-DD HH:mm:ss 格式的时间。');
  const [, yearText, monthText, dayText, hourText = '0', minuteText = '0', secondText = '0', fraction = '', offset] = parts;
  const year = Number(yearText), month = Number(monthText) - 1, day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const millis = Number(fraction.padEnd(3, '0'));
  const date = new Date(0);
  if (offset) {
    date.setUTCFullYear(year, month, day);
    date.setUTCHours(hour, minute, second, millis);
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day &&
        date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second) {
      if (offset.toUpperCase() === 'Z') return date;
      const digits = offset.slice(1).replace(':', '');
      const hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
      if (hours < 24 && minutes < 60) return new Date(+date - (offset[0] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60000);
    }
  } else {
    date.setHours(12, 0, 0, 0);
    date.setFullYear(year, month, day);
    date.setHours(hour, minute, second, millis);
    if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day &&
        date.getHours() === hour && date.getMinutes() === minute && date.getSeconds() === second) return date;
  }
  throw new Error('日期、时间或时区偏移无效。');
}

export function normalizeZone(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入时区，例如 Asia/Tokyo。');
  const zone = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,79}$/.test(zone)) throw new Error('请输入有效的 IANA 时区。');
  try { return new Intl.DateTimeFormat('en', {timeZone: zone}).resolvedOptions().timeZone; }
  catch { throw new Error('找不到该时区，请输入 IANA 名称（如 Asia/Tokyo）。'); }
}

export function savedZones(value) {
  const zones = new Set();
  if (Array.isArray(value?.zones)) {
    for (const candidate of value.zones.slice(0, maxExtraZones)) {
      try {
        const zone = normalizeZone(candidate);
        if (zone !== 'UTC') zones.add(zone);
      } catch { continue; }
    }
  }
  return [...zones];
}

export function formatTime(date, timeZone) {
  const options = {timeZone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23', timeZoneName: 'longOffset'};
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', options).formatToParts(date).map(part => [part.type, part.value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  const yearText = (year < 0 ? '-' : '') + String(Math.abs(year)).padStart(4, '0');
  const offset = parts.timeZoneName.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC+00:00');
  return `${yearText}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond} ${offset}`;
}

function textBytes(text) {
  if (text.length > textBudget) throw new Error('输入最多 64 KiB。');
  const bytes = encoder.encode(text);
  if (bytes.length > textBudget) throw new Error('输入最多 64 KiB。');
  return bytes;
}

export function encodeBase64(text) {
  const bytes = textBytes(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function decodeBase64(text) {
  const clean = text.replace(/[\t\n\f\r ]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (clean.length > base64Budget) throw new Error('Base64 文本超过解码上限。');
  let bytes;
  try {
    bytes = Uint8Array.from(atob(clean), character => character.charCodeAt(0));
  } catch { throw new Error('请输入可解码为 UTF-8 文本的 Base64。'); }
  if (bytes.length > textBudget) throw new Error('解码结果超过 64 KiB。');
  try { return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { throw new Error('请输入可解码为 UTF-8 文本的 Base64。'); }
}

export function hashText(text, algorithm) {
  if (!Object.hasOwn(hashAlgorithms, algorithm)) throw new Error('不支持此算法。');
  return Array.from(hashAlgorithms[algorithm](textBytes(text)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function uuidForms(random = globalThis.crypto) {
  if (!random?.getRandomValues) throw new Error('当前环境不支持随机生成 UUID。');
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const standard = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return {'标准格式': standard, '无连字符': hex, '全大写': standard.toUpperCase(), '全小写': standard};
}

qrcode.stringToBytes = text => [...encoder.encode(text)];

export function encodeQR(text) {
  if (!text.length) throw new Error('请输入二维码内容。');
  if (text.length > 2300 || encoder.encode(text).length > 2300) throw new Error('二维码内容最多 2300 字节。');
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  return code;
}

export function decodeQR(pixels, width, height) {
  const code = jsQR(pixels, width, height);
  if (!code) throw new Error('未找到可识别的二维码。');
  return code.data;
}
