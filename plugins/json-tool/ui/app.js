import { createJSONEditor } from 'vanilla-jsoneditor';
import { ready, readData, writeData, readLaunch } from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';
import { contentText, formatJSON, parser } from './format.js';

const status = document.querySelector('#status');
const error = document.querySelector('#error');
const reload = document.querySelector('#reload');
const format = document.querySelector('#format');
const compact = document.querySelector('#compact');
const clear = document.querySelector('#clear');
let revision = 0, generation = 0, saved = 0, timer, saving = false, blocked = false, loading = true;

function failure(message) { error.textContent = message; error.hidden = !message; }
function controls() { format.disabled = compact.disabled = clear.disabled = loading; }
function size() {
  document.querySelector('#size').textContent = `${new TextEncoder().encode(contentText(editor.get())).length.toLocaleString()} 字节`;
}
const editor = createJSONEditor({
  target: document.querySelector('#editor'),
  props: {
    content: { text: '' }, mode: 'text', parser, indentation: 2,
    mainMenuBar: false, navigationBar: false, statusBar: true,
    askToFormat: false, readOnly: true, ariaLabel: 'JSON 内容',
    onChange: () => { if (!loading) changed(); },
    onError: reason => failure(reason.message),
  }
});
async function save() {
  if (saving || blocked || loading || saved === generation) return;
  saving = true;
  const version = generation, text = contentText(editor.get());
  status.textContent = '正在保存…';
  try {
    const next = await writeData(revision, { text });
    revision = next.revision; saved = version;
    status.textContent = saved === generation ? '草稿已保存' : '草稿未保存';
  } catch {
    blocked = true; reload.hidden = false; status.textContent = '草稿未保存';
    failure('草稿保存失败，当前输入已保留。可继续编辑，或载入已存草稿。');
  } finally {
    saving = false;
    if (!blocked && saved !== generation) void save();
  }
}
function changed() {
  generation++; size(); failure('');
  status.textContent = blocked ? '草稿未保存' : '等待保存…';
  clearTimeout(timer); timer = setTimeout(save, 700);
}
async function load(useLaunch = false) {
  if (saving) return;
  clearTimeout(timer); loading = true; controls();
  editor.updateProps({ readOnly: true }); failure(''); status.textContent = '正在读取草稿…';
  const [draftResult, launchResult] = await Promise.allSettled([
    readData(), useLaunch ? readLaunch() : Promise.resolve({})
  ]);
  const incoming = launchResult.status === 'fulfilled' && typeof launchResult.value.input === 'string'
    ? launchResult.value.input : undefined;
  try {
    if (draftResult.status !== 'fulfilled') throw new Error('draft unavailable');
    const doc = draftResult.value; revision = doc.revision;
    const text = incoming ?? (typeof doc.value?.text === 'string' ? doc.value.text : '');
    editor.set({ text });
    generation = saved = 0; blocked = false; reload.hidden = true;
    // Merely opening a result must not overwrite the previous stored draft.
    status.textContent = incoming !== undefined ? '已载入输入内容' : revision ? '草稿已保存' : '输入或粘贴 JSON';
    if (launchResult.status === 'rejected') failure('无法读取打开参数，请更新宿主后重新打开。');
  } catch {
    if (incoming !== undefined) editor.set({ text: incoming });
    blocked = true; reload.hidden = false; status.textContent = '草稿读取失败';
    failure('无法读取草稿。可继续编辑，或重试载入已存草稿。');
  } finally {
    loading = false; editor.updateProps({ readOnly: false }); controls(); size();
  }
}
function run(isCompact) {
  if (loading) return;
  try {
    const text = formatJSON(contentText(editor.get()), isCompact);
    editor.update({ text }); changed(); editor.focus();
  } catch (reason) { failure(reason.message); }
}
format.addEventListener('click', () => run(false));
compact.addEventListener('click', () => run(true));
clear.addEventListener('click', () => { editor.update({ text: '' }); changed(); editor.focus(); });
reload.addEventListener('click', () => { if (!loading && !saving) void load(); });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) {
    event.preventDefault(); run(event.shiftKey);
  }
}, true);
ready(); void load(true);
