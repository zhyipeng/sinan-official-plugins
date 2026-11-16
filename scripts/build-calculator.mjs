import {build} from 'esbuild';
import {mkdir,rm,copyFile,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {selectedTargets} from './targets.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),source=join(root,'plugins/calculator');
for(const target of selectedTargets(process.argv.slice(2))){
 const [os,arch]=target.split('-'),out=join(root,'bin/targets',target,'calculator');
 await rm(out,{recursive:true,force:true});await mkdir(join(out,'ui'),{recursive:true});await mkdir(join(out,'backend'),{recursive:true});
 await build({entryPoints:[join(source,'ui/app.jsx')],outfile:join(out,'ui/app.js'),bundle:true,format:'esm',platform:'browser',target:['safari16.4','chrome119','firefox115'],minify:true,define:{'process.env.NODE_ENV':'"production"'}});
 for(const name of ['index.html'])await copyFile(join(source,'ui',name),join(out,'ui',name));
 await copyFile(join(source,'icon.svg'),join(out,'icon.svg'));
 let notices='Calculator dependencies (MIT)\n';
 for(const name of ['react','react-dom','scheduler']){
  const dir=join(root,'node_modules',name),license=(await readdir(dir)).find(file=>/^licen[sc]e(\.md|\.txt)?$/i.test(file));
  if(!license)throw new Error('依赖缺少许可：'+name);
  notices+=`\n--- ${name} ---\n${await readFile(join(dir,license),'utf8')}\n`;
 }
 await writeFile(join(out,'THIRD_PARTY_LICENSES.txt'),notices);
 await copyFile(join(root,'LICENSE'),join(out,'LICENSE'));
 const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8')),suffix=os==='windows'?'.exe':'';
 manifest.runtime.entry='backend/plugin'+suffix;
 const child=spawnSync('go',['build','-trimpath','-o',join(out,'backend/plugin'+suffix),'./backend'],{cwd:source,stdio:'inherit',env:{...process.env,GOOS:os,GOARCH:arch,CGO_ENABLED:'0'}});
 if(child.error)throw child.error;if(child.status!==0)process.exit(child.status||1);
 await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 let total=0;const files=await readdir(join(out,'ui'));for(const file of files){const size=(await stat(join(out,'ui',file))).size;if(size>512*1024)throw new Error('UI 单资源超过预算');total+=size;}
 if(files.length>128||total>2*1024*1024)throw new Error('UI 总资源超过预算');
 console.log(`计算插件已构建：${target}`);
}
