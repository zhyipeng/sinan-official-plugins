import {
  ready, execute, executeHidden, showWindow, hideWindow, readDependencies,
  stageDependencyImage, openDependency, discardDependencyImage, openDependencyManager,
} from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';
import {decodeChunk} from './transfer.js';

const status = document.getElementById('status');
const actions = document.getElementById('actions');
const copy = document.getElementById('copy');
const manage = document.getElementById('manage');
let disposed = false;
let job = '';

async function command(id, input) {
  const result = JSON.parse((await execute(id, input)).text);
  if (result.error) throw new Error(result.error);
  return result;
}

function release() {
  const id = job;
  job = '';
  if (id) void command('cancel', id).catch(() => {});
}

async function recognize() {
  let handle = '';
  try {
    const result = JSON.parse((await executeHidden('capture-region', 'ocr')).text);
    if (disposed) {
      if (result.id) void command('cancel', result.id).catch(() => {});
      return;
    }
    if (result.error || result.action !== 'ocr') return;

    job = result.id;
    const ocr = (await readDependencies()).find(dependency => dependency.id === 'ocr');
    if (ocr?.state !== 'available') {
      manage.hidden = false;
      throw new Error(ocr?.message || 'OCR 插件不可用');
    }
    if (!Number.isSafeInteger(result.size) || result.size < 1 || result.size > 4 * 1024 * 1024) {
      throw new Error('OCR 图片超过 4 MiB 或内容为空');
    }

    const chunks = [];
    for (let offset = 0; offset < result.size;) {
      const chunk = decodeChunk((await command('read', `${job}:${offset}`)).data);
      if (!chunk.length || offset + chunk.length > result.size) throw new Error('截图分块无效');
      if (disposed) return;
      chunks.push(chunk);
      offset += chunk.length;
    }

    status.textContent = '正在打开 OCR…';
    handle = await stageDependencyImage('ocr', 'recognize-image', new Blob(chunks, {type: 'image/png'}));
    if (disposed) return;
    // The existing host replaces the embedded view without revealing its window.
    await showWindow();
    if (disposed) return;
    await openDependency('ocr', 'recognize-image', {imageHandle: handle});
    handle = '';
  } catch (error) {
    if (!disposed && job) {
      status.textContent = error.message || '无法打开 OCR';
      actions.hidden = false;
      await showWindow().catch(() => {});
    }
  } finally {
    if (handle) await discardDependencyImage(handle).catch(() => {});
  }
}

copy.addEventListener('click', async () => {
  if (!job) return;
  copy.disabled = true;
  try {
    await command('copy', job);
    job = '';
    actions.hidden = true;
    await hideWindow();
  } catch (error) {
    status.textContent = error.message || '复制失败';
  } finally {
    copy.disabled = false;
  }
});

manage.addEventListener('click', () => {
  void openDependencyManager().catch(error => { status.textContent = error.message; });
});

document.getElementById('close').addEventListener('click', () => {
  release();
  actions.hidden = true;
  void hideWindow().catch(() => {});
});

window.addEventListener('pagehide', () => {
  disposed = true;
  release();
});
ready();
void recognize();
