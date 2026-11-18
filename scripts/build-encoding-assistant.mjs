import {build} from 'esbuild';
import {copyFile, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'plugins/encoding-assistant');
const out = join(root, 'bin/plugins/encoding-assistant');
await rm(out, {recursive: true, force: true});
await mkdir(join(out, 'ui'), {recursive: true});
await build({absWorkingDir: root, entryPoints: [join(source, 'ui/app.js')], outfile: join(out, 'ui/app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: ['safari16.4', 'chrome119', 'firefox115'], minify: true, legalComments: 'inline'});
for (const file of ['manifest.json', 'icon.svg', 'ui/index.html', 'ui/style.css']) await copyFile(join(source, file), join(out, file));
const licenses = [['@noble/hashes', 'node_modules/@noble/hashes/LICENSE'], ['jsqr', 'node_modules/jsqr/LICENSE'],
  ['qrcode-generator', 'plugins/encoding-assistant/licenses/qrcode-generator.txt']];
const notices = await Promise.all(licenses.map(async ([name, file]) => `--- ${name} ---\n${await readFile(join(root, file), 'utf8')}`));
await writeFile(join(out, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n'));
let total = 0;
for (const file of ['app.js', 'index.html', 'style.css']) {
  const {size} = await stat(join(out, 'ui', file));
  if (size > 512 * 1024) throw new Error(`${file} 超出宿主单资源预算。`);
  total += size;
}
console.log(`编码助手已构建：3 个 UI 资源，${total} 字节；无后端、无 CDN。`);
