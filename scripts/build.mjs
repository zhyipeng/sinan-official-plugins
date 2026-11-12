import { build } from 'esbuild';
import { parse } from 'acorn';
import { readFile, writeFile, mkdir, rm, copyFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'bin/plugins/json-tool');
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'ui'), { recursive: true });
let extracted = [];
// The pinned vanilla distribution injects component CSS. Extract it into a local
// stylesheet instead: the host intentionally forbids inline <style> elements.
const isolatedStyles = {
  name: 'isolated-editor-styles',
  setup(build) {
    build.onLoad({ filter: /vanilla-jsoneditor\/index\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const ast = parse(contents, { ecmaVersion: 'latest', sourceType: 'module' });
      const edits = [];
      function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Vc') {
          if (node.arguments.length !== 1 || typeof node.arguments[0].value !== 'string') throw new Error('上游 CSS 注入方式已变化');
          extracted.push(node.arguments[0].value);
          edits.push([node.start, node.end]);
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) value.forEach(visit);
          else if (value && typeof value === 'object') visit(value);
        }
      }
      visit(ast);
      if (extracted.length !== 54) throw new Error(`上游 CSS 注入数量已变化：${extracted.length}`);
      for (const [start, end] of edits.reverse()) contents = contents.slice(0, start) + 'void 0' + contents.slice(end);
      return { contents, loader: 'js', resolveDir: root + '/node_modules/vanilla-jsoneditor' };
    });
    build.onLoad({ filter: /style-mod\/src\/style-mod\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const condition = '!root.head && root.adoptedStyleSheets && win.CSSStyleSheet';
      if (!contents.includes(condition)) throw new Error('CodeMirror 样式挂载实现已变化');
      // CSSOM sheets also work on Document. Avoid its inline <style> fallback;
      // requires Safari 16.4+ (the desktop host already uses modern WebKit).
      contents = contents.replace(condition, 'root.adoptedStyleSheets && win.CSSStyleSheet');
      contents = contents.replace('this.styleTag = doc.createElement("style")', 'throw new Error("JSON 工具需要支持 CSSStyleSheet 的 WebKit（Safari 16.4+）")');
      return { contents, loader: 'js' };
    });
  }
};
await build({
  absWorkingDir: root,
  // Shared entry points force deterministic ESM chunks below the 512 KiB cap.
  entryPoints: {
    app: 'plugins/json-tool/ui/app.js',
    'vendor-view': '@codemirror/view',
    'vendor-state': '@codemirror/state',
    'vendor-language': '@codemirror/language',
    'vendor-commands': '@codemirror/commands',
    'vendor-query': '@jsonquerylang/jsonquery',
    'vendor-ajv': 'ajv',
    'vendor-acorn': 'acorn',
    'vendor-lodash': 'lodash-es',
    'vendor-jsonpath': 'jsonpath-plus',
    'vendor-jsonrepair': 'jsonrepair',
    'vendor-search': '@codemirror/search',
    'vendor-autocomplete': '@codemirror/autocomplete',
  },
  outdir: path.join(out, 'ui'),
  bundle: true, splitting: true, format: 'esm', platform: 'browser',
  alias: { 'vanilla-picker': 'vanilla-picker/csp' },
  target: ['safari16.4'], minify: true, sourcemap: false,
  legalComments: 'inline', plugins: [isolatedStyles],
});
await writeFile(path.join(out, 'ui/editor.css'), extracted.join('\n') + '\n' + await readFile(path.join(root, 'node_modules/vanilla-picker/dist/vanilla-picker.csp.css'), 'utf8'));
for (const file of ['index.html', 'style.css']) {
  await copyFile(path.join(root, 'plugins/json-tool/ui', file), path.join(out, 'ui', file));
}
await copyFile(path.join(root, 'plugins/json-tool/manifest.json'), path.join(out, 'manifest.json'));
await copyFile(path.join(root, 'plugins/json-tool/icon.svg'), path.join(out, 'icon.svg'));
let total = 0, count = 0;
for (const name of await readdir(path.join(out, 'ui'))) {
  const size = (await stat(path.join(out, 'ui', name))).size;
  if (size > 512 * 1024) throw new Error(`${name} 超过宿主单文件 512 KiB 限制：${size}`);
  total += size; count++;
}
if (total > 2 * 1024 * 1024 || count > 128) throw new Error('UI 资源超过宿主预算');
console.log(`JSON 工具已构建：${count} 个资源，${total} 字节；无后端、无 CDN。`);
