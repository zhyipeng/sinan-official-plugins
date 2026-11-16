import {spawnSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {selectedTargets} from './targets.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),source=join(root,'plugins/ocr');
for(const target of selectedTargets(process.argv.slice(2))){
 const [os,arch]=target.split('-'),out=join(root,'bin/ocr-backends',target);
 await mkdir(out,{recursive:true});
 const env={...process.env,GOOS:os,GOARCH:arch,CGO_ENABLED:'0'};
 for(const args of [['build','-trimpath','-o',join(out,'plugin'+(os==='windows'?'.exe':'')),'./backend'],['vet','./backend','./internal/...']]){
  const child=spawnSync('go',args,{cwd:source,env,stdio:'inherit'});
  if(child.error)throw child.error;if(child.status!==0)process.exit(child.status||1);
 }
 console.log(`OCR 后台编译/静态检查通过：${target}；不包含原生引擎，不是目标插件包`);
}
