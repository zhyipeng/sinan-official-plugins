// 由 GitHub Actions 的 <plugin-id>-v<version> 标签触发：从 dist/assets.json
// 中筛选该插件的六目标产物，以草稿创建 Release、上传资产后正式发布。
// 只发布 GitHub Release 资产；商店（sinan-plugin-registry）登记仍由人工完成。
// 本地可用 --dry-run 只校验标签、清单与资产一致性，不调用 gh。
import {readFile, writeFile, readdir, access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dry = process.argv.includes('--dry-run');
const args = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const tag = (args[0] || process.env.TAG || '').trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

const match = /^(.+)-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
if (!match) fail(`标签格式无效：${tag || '(空)'}；应为 <plugin-id>-v<version>，例如 tools.calendar-v0.1.3`);
const [, pluginId, version] = match;

// 由插件清单确定目录与展示名，避免把目录名与插件 ID 混用。
let plugin = null;
for (const directory of await readdir(path.join(root, 'plugins'))) {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'plugins', directory, 'manifest.json'), 'utf8'));
    if (manifest.id === pluginId) {
      plugin = {directory, manifest};
      break;
    }
  } catch {
    // 跳过非插件目录/无清单目录。
  }
}
if (!plugin) fail(`找不到插件 ID：${pluginId}`);
if (plugin.manifest.version !== version) {
  fail(`标签版本 ${version} 与清单 plugins/${plugin.directory}/manifest.json 的 ${plugin.manifest.version} 不一致`);
}
if (plugin.directory === 'ocr') {
  fail('OCR 完整包依赖固定上游源码、模型与 C++ 工具链，须按 plugins/ocr/README 本地构建后手动发布；CI 不支持自动发布 OCR。');
}

const assets = JSON.parse(await readFile(path.join(root, 'dist/assets.json'), 'utf8')).filter((asset) => asset.id === pluginId);
if (assets.length !== 6) {
  fail(`${pluginId} 产物数量为 ${assets.length}，期望 6（darwin/windows/linux × arm64/amd64），构建不完整。`);
}
for (const asset of assets) {
  if (asset.version !== version) fail(`产物 ${asset.file} 版本 ${asset.version} 与标签 ${version} 不一致`);
}

const assetsFile = path.join(root, 'dist', `${pluginId}-${version}-assets.json`);
const notesFile = path.join(root, 'dist', `${pluginId}-${version}-release-notes.md`);
await writeFile(assetsFile, `${JSON.stringify(assets, null, 2)}\n`, 'utf8');

const notes = [
  `# ${plugin.manifest.name} v${version}`,
  '',
  `- 插件 ID：\`${pluginId}\``,
  `- 版本：${version}`,
  '',
  '## 资产（六目标）',
  '',
  ...assets.map((asset) => `- \`${asset.file}\`（${asset.os}-${asset.arch}，${asset.size} bytes）sha256 \`${asset.sha256}\``),
  '',
  '> 商店登记（sinan-plugin-registry）仍由人工完成，本工作流只发布 GitHub Release 资产。',
  '',
];
await writeFile(notesFile, notes.join('\n'), 'utf8');

const files = [assetsFile];
for (const asset of assets) {
  files.push(path.join(root, 'dist', asset.file), path.join(root, 'dist', `${asset.file}.sha256`));
}
if (!dry) {
  for (const file of files) {
    try {
      await access(file);
    } catch {
      fail(`缺少资产文件：${path.relative(root, file)}`);
    }
  }
}

function gh(argv) {
  return spawnSync('gh', argv, {cwd: root, encoding: 'utf8'});
}

if (dry) {
  console.log(`[dry-run] ${tag}：${assets.length} 个包，${files.length} 个上传文件`);
  for (const asset of assets) console.log(`  ${asset.file}`);
  process.exit(0);
}

// 已发布的 Release 拒绝覆盖（AGENTS：不改写已发布资产）；仅允许续传草稿。
const view = gh(['release', 'view', tag, '--json', 'isDraft']);
let draftExists = false;
if (view.status === 0) {
  let info = {};
  try {
    info = JSON.parse(view.stdout);
  } catch {
    // 输出异常时按已存在处理，避免误建。
  }
  if (info.isDraft !== true) fail(`Release ${tag} 已存在且非草稿，拒绝覆盖已发布资产。`);
  draftExists = true;
}

if (!draftExists) {
  const created = gh(['release', 'create', tag, '--draft', '--verify-tag', '--title', `${plugin.manifest.name} v${version}`, '--notes-file', notesFile]);
  if (created.status !== 0) fail(`创建 Release 失败：${created.stderr || created.stdout}`);
}

const uploaded = gh(['release', 'upload', tag, ...files, '--clobber']);
if (uploaded.status !== 0) fail(`上传资产失败：${uploaded.stderr || uploaded.stdout}`);

const published = gh(['release', 'edit', tag, '--draft=false']);
if (published.status !== 0) fail(`发布 Release 失败：${published.stderr || published.stdout}`);

console.log(`已发布 ${tag}：${assets.length} 个六目标包及摘要。`);
