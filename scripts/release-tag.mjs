// Repository-wide tags must include plugin identity; versions remain per plugin.
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
export function releaseTag(manifest) {
  if (typeof manifest?.id!=='string' || manifest.id!==manifest.id.trim() || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(manifest?.id ?? '') || manifest.id.length>128 || manifest.id.startsWith('system.')) throw new Error('插件 ID 无效');
  if (typeof manifest.version!=='string' || manifest.version!==manifest.version.trim() || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version ?? '') || manifest.version.length>32 || manifest.version.split('.').some(n=>!Number.isSafeInteger(Number(n)))) throw new Error('插件版本无效');
  return `${manifest.id}-v${manifest.version}`;
}
export async function tagForPlugin(directory) {
  if (typeof directory!=='string' || directory!==directory.trim() || !/^[a-z][a-z0-9-]*$/.test(directory)) throw new Error('请指定 plugins 下的插件目录名称');
  const root=fileURLToPath(new URL('../plugins/',import.meta.url));
  return releaseTag(JSON.parse(await readFile(path.join(root,directory,'manifest.json'),'utf8')));
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {if(process.argv.length!==3)throw new Error('用法：node scripts/release-tag.mjs <插件目录>');console.log(await tagForPlugin(process.argv[2]));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
