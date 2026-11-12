import { parse, stringify } from 'lossless-json';

export const parser = { parse, stringify };
export function contentText(content) {
  return typeof content.text === 'string' ? content.text : stringify(content.json, null, 2);
}
export function formatJSON(text, compact = false) {
  if (!text.trim()) throw new Error('请输入 JSON');
  try {
    return stringify(parse(text), null, compact ? undefined : 2);
  } catch (reason) {
    const position = /position (\d+)/.exec(reason.message);
    if (!position) throw new Error('JSON 格式错误，请检查输入');
    const offset = Number(position[1]);
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - before.lastIndexOf('\n');
    const problem = reason.message.startsWith('Duplicate key') ? '存在重复的键' : 'JSON 格式错误';
    throw new Error(`${problem}：第 ${line} 行，第 ${column} 列`);
  }
}
