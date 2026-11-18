import { execute, pickPath, readLaunch, ready } from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';

const $ = id => document.getElementById(id);
const elements = {
  search: $('search'), scripts: $('scripts'), status: $('status'), editor: $('editor'),
  name: $('name'), keywords: $('keywords'), source: $('source'),
  directory: $('directory-choice'), environment: $('environment-choice'),
};
const tabs = [...document.querySelectorAll('nav button')];
const state = {
  panel: 'library', settings: { directories: [], automatic: [], manual: [] },
  offset: 0, query: '', version: 0, busy: false, editor: null,
};
const statusLabels = { running: '运行中', completed: '上次运行成功', failed: '上次运行失败' };
let searchTimer;
let pollTimer;
let lastPage;
let outputTimer;
let activeOutput;

function message(error) {
  return error instanceof Error ? error.message : '操作失败，请重试';
}

function status(text) {
  elements.status.textContent = text;
  elements.status.hidden = !text;
}

async function request(command, input = '') {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input);
  const size = new TextEncoder().encode(JSON.stringify({ method: 'command.execute', commandId: command, input: serialized })).length;
  if (size > 64 * 1024) throw new Error('脚本内容过长，请缩短后再保存');
  const response = await execute(command, serialized);
  const data = JSON.parse(response.text);
  if (data?.error) throw new Error(data.error);
  return data;
}

function button(label, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function line(value, style) {
  const element = document.createElement('span');
  element.className = style;
  element.textContent = value;
  if (style === 'path' || style === 'file-name') element.title = value;
  return element;
}

function row(label, path, details, buttons) {
  const element = document.createElement('li');
  element.className = 'row';
  const identity = document.createElement('div');
  identity.className = 'identity';
  identity.append(line(label, 'file-name'));
  if (path) identity.append(line(path, 'path'));
  if (details) identity.append(line(details, 'meta'));
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.append(...buttons);
  element.append(identity, actions);
  return element;
}

function updateButtons() {
  $('refresh').disabled = state.busy;
  $('import').disabled = state.busy;
  $('create').disabled = state.busy || !state.settings.directories.length;
  $('add-directory').disabled = state.busy;
  $('add-environment').disabled = state.busy;
  $('save').disabled = state.busy;
  $('cancel').disabled = state.busy;
  $('remove-import').disabled = state.busy;
}

async function action(fn, errorTarget = status) {
  if (state.busy) return;
  state.busy = true;
  updateButtons();
  try {
    await fn();
  } catch (error) {
    errorTarget(message(error));
  } finally {
    state.busy = false;
    updateButtons();
  }
}

async function loadSettings() {
  const data = await request('settings');
  state.settings = data;
  $('directory-list').replaceChildren(...data.directories.map(path => row(path, '', '', [
    button('移除', () => action(async () => {
      await request('change', { action: 'remove-directory', path });
      await refreshAll();
    })),
  ])));
  $('directories-empty').hidden = data.directories.length > 0;
  $('automatic-environments').replaceChildren(...data.automatic.map(env => row(env.name, env.path, '', [])));
  $('automatic-empty').hidden = data.automatic.length > 0;
  $('manual-environments').replaceChildren(...data.manual.map(env => row(env.name, env.path, '', [
    button('移除', () => action(async () => {
      await request('change', { action: 'remove-environment', id: env.id });
      await refreshAll();
    })),
  ])));
  $('manual-empty').hidden = data.manual.length > 0;
  updateButtons();
}

function renderScripts(data) {
  const { items, total, pageSize } = data;
  const serialized = JSON.stringify(items);
  if (lastPage !== serialized) {
    lastPage = serialized;
    const focused = document.activeElement?.dataset.scriptAction;
    elements.scripts.replaceChildren(...items.map(item => {
      const run = button('运行', () => action(async () => {
        const result = await request('start', item.id);
        if (result.showOutput) {
          showOutput(result);
        } else {
          status(result.detail || '');
          await loadScripts();
        }
      }));
      run.dataset.scriptAction = item.id + '-run';
      run.disabled = !item.exists || item.status === 'running';
      const edit = button('设置', () => {
        if (!state.busy) openEditor({ action: 'edit', item });
      });
      edit.dataset.scriptAction = item.id + '-edit';
      const runtime = item.exists ? (item.resolved || '环境不可用') : '文件不可用';
      const details = [runtime, statusLabels[item.status], item.delivery === 'unavailable' && '通知不可用', ...(item.keywords || [])]
        .filter(Boolean).join(' · ');
      const actions = [run, edit];
      if (item.resultId && (item.showOutput || item.status !== 'running')) {
        const result = button('结果', () => action(async () => showOutput(await request('run-status', item.resultId))));
        result.dataset.scriptAction = item.id + '-result';
        actions.push(result);
      }
      return row(item.name, item.path, details, actions);
    }));
    if (focused) {
      const replacement = [...elements.scripts.querySelectorAll('button')].find(control => control.dataset.scriptAction === focused);
      if (replacement && !replacement.disabled) replacement.focus();
    }
  }
  $('empty').hidden = items.length > 0;
  $('empty').textContent = state.query
    ? '未找到匹配的脚本。'
    : '暂无脚本。添加目录、导入文件或新建脚本。';
  $('pagination').hidden = total <= pageSize;
  $('page-info').textContent = total ? `${state.offset + 1}–${state.offset + items.length} / ${total}` : '';
  $('previous').disabled = state.offset === 0;
  $('next').disabled = state.offset + pageSize >= total;
}

async function loadScripts(refresh = false, retries = 1) {
  const id = ++state.version;
  const data = await request('list', { query: state.query, offset: state.offset, refresh });
  if (id !== state.version) return;
  if (!data.items.length && state.offset > 0 && retries) {
    state.offset = Math.max(0, Math.floor((data.total - 1) / data.pageSize) * data.pageSize);
    return loadScripts(false, retries - 1);
  }
  state.pageSize = data.pageSize;
  renderScripts(data);
  if (data.limited || data.missingDirectories) {
    status(data.limited ? '已达到扫描上限，请减少脚本目录。' : `${data.missingDirectories} 个脚本目录暂不可用。`);
  }
  clearTimeout(pollTimer);
  if (data.items.some(item => item.status === 'running' || item.delivery === 'pending')) {
    pollTimer = setTimeout(() => {
      if (state.panel === 'library' && !state.busy && !elements.editor.open && !document.hidden) {
        loadScripts().catch(error => status(message(error)));
      }
    }, 2000);
  }
}

async function refreshAll(force = false) {
  await loadSettings();
  await loadScripts(force);
}

function showPanel(panel, reload = true) {
  activeOutput = undefined;
  clearTimeout(outputTimer);
  $('library-toolbar').hidden = false;
  $('output-view').hidden = true;
  $('output-text').textContent = '';
  $('output-path').textContent = '';
  state.panel = panel;
  for (const tab of tabs) {
    const current = tab.dataset.panel === panel;
    if (current) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
    $(tab.dataset.panel).hidden = !current;
  }
  status('');
  if (panel === 'library' && reload) loadScripts().catch(error => status(message(error)));
}

function option(value, label) {
  return new Option(label, value);
}

function defaultEnvironment(name) {
  if (!name) return '自动选择';
  return /\.(py|js|sh)$/i.test(name) ? '自动匹配' : '直接执行（默认）';
}

function editorError(text) {
  $('editor-error').textContent = text;
  $('editor-error').hidden = !text;
}

function openEditor(data) {
  const { action, item, path } = data;
  state.editor = data;
  const create = action === 'create';
  const addEnvironment = action === 'add-environment';
  const title = { create: '新建脚本', import: '导入脚本', edit: '脚本设置', 'add-environment': '添加环境' };
  $('editor-title').textContent = title[action];
  $('selected-path').textContent = item?.path || path || '';
  $('selected-path').title = $('selected-path').textContent;
  $('selected-path').hidden = !$('selected-path').textContent;
  $('directory-field').hidden = !create;
  elements.directory.replaceChildren(...state.settings.directories.map(dir => option(dir, dir)));
  $('name-field').hidden = !create && !addEnvironment;
  $('name-label').textContent = create ? '文件名' : '环境名称';
  elements.name.placeholder = create ? 'example.py' : '例如 项目 Python';
  elements.name.required = create || addEnvironment;
  elements.name.value = addEnvironment ? path.split(/[\\/]/).at(-1) : '';
  elements.source.value = '';
  $('source-field').hidden = !create;
  $('environment-field').hidden = addEnvironment;
  $('keywords-field').hidden = addEnvironment;
  $('script-options').hidden = addEnvironment;
  $('searchable').checked = !item?.hideFromSearch;
  $('show-output').checked = Boolean(item?.showOutput);
  elements.keywords.value = item?.keywords?.join(', ') || '';
  const envs = [...state.settings.automatic, ...state.settings.manual];
  const choice = item?.environment || '';
  const options = [option('', defaultEnvironment(item?.name || path)), option('direct', '直接执行')];
  options.push(...envs.map(env => option(env.id, env.name)));
  if (choice && !options.some(item => item.value === choice)) options.push(option(choice, '已选环境不可用'));
  elements.environment.replaceChildren(...options);
  elements.environment.value = choice;
  $('remove-import').hidden = !item?.imported;
  $('save').textContent = create ? '创建脚本' : action === 'import' ? '导入脚本' : '保存';
  editorError('');
  elements.editor.showModal();
  if (create || addEnvironment) elements.name.focus();
  else elements.environment.focus();
}

elements.name.addEventListener('input', () => {
  if (state.editor?.action === 'create') {
    elements.environment.options[0].textContent = defaultEnvironment(elements.name.value);
  }
});
$('cancel').addEventListener('click', () => elements.editor.close());
elements.editor.addEventListener('cancel', event => {
  if (state.busy) event.preventDefault();
});
elements.editor.addEventListener('close', () => {
  if (elements.editor.open) return;
  state.editor = null;
  elements.source.value = '';
});

$('editor-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!state.editor) return;
  void action(async () => {
    editorError('');
    const { action, item, path } = state.editor;
    await request('change', {
      action,
      id: item?.id,
      path: action === 'create' ? elements.directory.value : path,
      name: elements.name.value.trim(),
      environment: elements.environment.value,
      keywords: elements.keywords.value.split(/[,，]/).map(word => word.trim()).filter(Boolean),
      text: elements.source.value,
      hideFromSearch: !$('searchable').checked,
      showOutput: $('show-output').checked,
    });
    elements.editor.close();
    status({ create: '已创建脚本', import: '已导入脚本' }[action] || '已保存');
    await refreshAll();
  }, error => elements.editor.open ? editorError(error) : status(error));
});

$('remove-import').addEventListener('click', () => action(async () => {
  await request('change', { action: 'remove-import', id: state.editor.item.id });
  elements.editor.close();
  status('已取消导入');
  await refreshAll();
}, error => elements.editor.open ? editorError(error) : status(error)));

for (const tab of tabs) tab.addEventListener('click', () => {
  if (!state.busy) showPanel(tab.dataset.panel);
});
$('refresh').addEventListener('click', () => action(async () => {
  status('');
  await refreshAll(true);
}));
$('add-directory').addEventListener('click', () => action(async () => {
  const path = await pickPath('directory');
  if (path) {
    await request('change', { action: 'add-directory', path });
    await refreshAll();
  }
}));
$('add-environment').addEventListener('click', () => action(async () => {
  const path = await pickPath('file');
  if (path) openEditor({ action: 'add-environment', path });
}));
$('import').addEventListener('click', () => action(async () => {
  const path = await pickPath('file');
  if (path) openEditor({ action: 'import', path });
}));
$('create').addEventListener('click', () => openEditor({ action: 'create' }));
function scheduleSearch(event) {
  if (event.isComposing) return;
  state.query = elements.search.value;
  state.offset = 0;
  state.version++;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadScripts().catch(error => status(message(error))), 180);
}
elements.search.addEventListener('input', scheduleSearch);
elements.search.addEventListener('compositionend', scheduleSearch);
$('previous').addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - state.pageSize);
  loadScripts().catch(error => status(message(error)));
});
$('next').addEventListener('click', () => {
  state.offset += state.pageSize;
  loadScripts().catch(error => status(message(error)));
});

function updateOutput(result) {
  $('output-title').textContent = result.name || '脚本输出';
  const label = { running: '运行中', completed: '执行成功', failed: '执行失败' }[result.status];
  $('output-state').textContent = [label, result.detail].filter(Boolean).join(' · ');
  const output = result.output || (result.status === 'running' ? '等待输出…' : '无输出');
  if ($('output-text').textContent !== output) $('output-text').textContent = output;
  const notes = [];
  if (result.previewOnly) notes.push(result.path ? '页面仅显示输出预览，完整内容见临时日志。' : '页面仅显示输出预览。');
  if (result.incomplete) notes.push('部分输出未能保存。');
  if (result.delivery === 'unavailable') notes.push('系统通知不可用。');
  $('output-note').textContent = notes.join(' ');
  $('output-note').hidden = !notes.length;
  $('output-path').textContent = result.path || '';
  $('output-path').hidden = !result.path;
  clearTimeout(outputTimer);
  if (result.status === 'running' || result.delivery === 'pending') {
    outputTimer = setTimeout(() => pollOutput(result.id), 1000);
  }
}

async function pollOutput(id) {
  if (activeOutput !== id || document.hidden) return;
  try {
    const result = await request('run-status', id);
    if (activeOutput === id) updateOutput(result);
  } catch (error) {
    if (activeOutput === id) {
      $('output-state').textContent = message(error);
      outputTimer = setTimeout(() => pollOutput(id), 2000);
    }
  }
}

function showOutput(result) {
  activeOutput = result.id;
  state.panel = 'output';
  clearTimeout(pollTimer);
  $('library-toolbar').hidden = true;
  for (const tab of tabs) $(tab.dataset.panel).hidden = true;
  status('');
  $('output-view').hidden = false;
  updateOutput(result);
  $('back-to-list').focus();
}

$('back-to-list').addEventListener('click', () => action(async () => {
  showPanel('library', false);
  await refreshAll();
  elements.search.focus();
}));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (activeOutput) void pollOutput(activeOutput);
  else if (state.panel === 'library') loadScripts().catch(error => status(message(error)));
});

ready();
void action(async () => {
  const launch = await readLaunch();
  if (launch.commandId === 'run-view') {
    try {
      showOutput(await request('start-output', launch.input));
    } catch (error) {
      showOutput({ status: 'failed', detail: message(error) });
    }
    return;
  }
  await refreshAll();
});
