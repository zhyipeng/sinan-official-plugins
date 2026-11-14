import {build} from 'esbuild';
import {mkdir,rm,copyFile,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {selectedTargets} from './targets.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),source=join(root,'plugins/clipboard');
const selected=selectedTargets(process.argv.slice(2));
if(process.platform!=='darwin'&&selected.some(target=>target.startsWith('darwin-')))throw new Error('macOS 剪贴板使用 Cocoa/CGO，必须在 macOS 构建；其他平台可交叉构建 Windows/Linux。');
for(const target of selected){
 const [os,arch]=target.split('-'),out=join(root,'bin/targets',target,'clipboard');
 await rm(out,{recursive:true,force:true});await mkdir(join(out,'ui'),{recursive:true});await mkdir(join(out,'backend'),{recursive:true});
 await build({entryPoints:[join(source,'ui/app.js')],outfile:join(out,'ui/app.js'),bundle:true,format:'esm',platform:'browser',target:['safari16.4','chrome119','firefox115'],minify:true});
 for(const name of ['index.html','style.css'])await copyFile(join(source,'ui',name),join(out,'ui',name));
 await copyFile(join(source,'icon.svg'),join(out,'icon.svg'));
 const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
 const suffix=os==='windows'?'.exe':'';manifest.runtime.entry='backend/plugin'+suffix;
 const env={...process.env,GOOS:os,GOARCH:arch,CGO_ENABLED:os==='darwin'?'1':'0'};
 if(os==='darwin')env.MACOSX_DEPLOYMENT_TARGET='12.0';
 const child=spawnSync('go',['build','-trimpath','-o',join(out,'backend/plugin'+suffix),'./backend'],{cwd:source,stdio:'inherit',env});
 if(child.error)throw child.error;if(child.status!==0)process.exit(child.status||1);
 await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(`剪贴板插件已构建：${target}`);
}
