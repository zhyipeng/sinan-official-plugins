import {build} from 'esbuild';
import {copyFile,readFile,mkdir,rm,readdir,stat,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'bin/plugins/calendar');
await rm(out,{recursive:true,force:true});
await mkdir(path.join(out,'ui'),{recursive:true});
await build({absWorkingDir:root,entryPoints:{app:'plugins/calendar/ui/app.jsx'},outdir:path.join(out,'ui'),bundle:true,format:'esm',platform:'browser',target:['safari16.4','chrome119','firefox115'],minify:true,define:{'process.env.NODE_ENV':'"production"'},legalComments:'inline'});
await copyFile(path.join(root,'plugins/calendar/ui/index.html'),path.join(out,'ui/index.html'));
for(const name of ['manifest.json','icon.svg'])await copyFile(path.join(root,'plugins/calendar',name),path.join(out,name));
// Preserve upstream licenses in the distributed package, not only the source tree.
let notices='Calendar dependencies (MIT)\n';
for(const name of ['@daypicker/react','react-day-picker','react','react-dom','scheduler','date-fns','@date-fns/tz','chinese-days']){
  const dir=path.join(root,'node_modules',name);
  const license=(await readdir(dir)).find(file=>/^licen[sc]e(\.md|\.txt)?$/i.test(file));
  if(!license)throw new Error(`依赖缺少许可：${name}`);
  notices+=`\n--- ${name} ---\n${await readFile(path.join(dir,license),'utf8')}\n`;
}
await writeFile(path.join(out,'THIRD_PARTY_LICENSES.txt'),notices);
let total=0,count=0;
for(const name of await readdir(path.join(out,'ui'))){const size=(await stat(path.join(out,'ui',name))).size;if(size>512*1024)throw new Error(`${name} 超过 512 KiB`);total+=size;count++;}
if(total>2*1024*1024||count>128)throw new Error('日历 UI 资源超过宿主预算');
console.log(`日历已构建：${count} 个 UI 资源，${total} 字节；无后端、无 CDN。`);
