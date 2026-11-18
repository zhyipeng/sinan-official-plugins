import {build} from 'esbuild';
import {mkdir, rm, copyFile, readFile, writeFile, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {selectedTargets} from './targets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'plugins/script');
for (const target of selectedTargets(process.argv.slice(2))) {
  const [os, arch] = target.split('-');
  const out = join(root, 'bin/targets', target, 'script');
  await rm(out, {recursive: true, force: true});
  await mkdir(join(out, 'backend'), {recursive: true});
  await build({
    entryPoints: [join(source, 'ui/app.js')],
    outfile: join(out, 'ui/app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['safari16.4', 'chrome119', 'firefox115'],
    minify: true,
  });
  const resources = ['index.html', 'style.css'];
  for (const file of resources) {
    await copyFile(join(source, 'ui', file), join(out, 'ui', file));
  }
  for (const file of ['app.js', ...resources]) {
    if ((await stat(join(out, 'ui', file))).size > 512 * 1024) throw new Error('脚本插件 UI 资源超过限制');
  }

  await copyFile(join(source, 'icon.svg'), join(out, 'icon.svg'));
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.runtime.entry = os === 'windows' ? 'backend/plugin.exe' : 'backend/plugin';
  const child = spawnSync('go', ['build', '-trimpath', '-o', join(out, manifest.runtime.entry), './backend'], {
    cwd: source,
    stdio: 'inherit',
    env: {...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0'},
  });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status || 1);
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`脚本插件已构建：${target}`);
}
