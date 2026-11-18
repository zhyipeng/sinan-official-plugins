import {build} from 'esbuild';
import {mkdir,rm,copyFile,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {painterroPlugin,writePainterroAssets,verifyPainterro,checkScreenshotBudget} from './painterro-csp.mjs';
import {selectedTargets} from './targets.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),source=join(root,'plugins/screenshot');
const selected=selectedTargets(process.argv.slice(2));
if(selected.some(target=>target.startsWith('darwin-')) && process.platform!=='darwin'){
 throw new Error('构建 macOS 截图包需要 macOS 上的 Xcode Command Line Tools 和 macOS 14 或更新的 SDK');
}
await verifyPainterro();
for(const target of selected){
 const [os,arch]=target.split('-'),out=join(root,'bin/targets',target,'screenshot');
 await rm(out,{recursive:true,force:true});await mkdir(join(out,'ui'),{recursive:true});await mkdir(join(out,'backend'),{recursive:true});
 await build({entryPoints:[join(source,'ui/app.js')],outfile:join(out,'ui/app.js'),bundle:true,format:'esm',platform:'browser',target:['safari16.4','chrome119','firefox115'],minify:true,plugins:[painterroPlugin()]});
 await writePainterroAssets(join(out,'ui'));
 for(const name of ['index.html','style.css'])await copyFile(join(source,'ui',name),join(out,'ui',name));
 const budget=await checkScreenshotBudget(join(out,'ui'));
 await copyFile(join(source,'icon.svg'),join(out,'icon.svg'));
 const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
 const suffix=os==='windows'?'.exe':'';manifest.runtime.entry='backend/plugin'+suffix;
 const env={...process.env,GOOS:os,GOARCH:arch,CGO_ENABLED:'0'};
 const child=spawnSync('go',['build','-trimpath',...(os==='windows'?['-ldflags=-H=windowsgui']:[]),'-o',join(out,'backend/plugin'+suffix),'./backend'],{cwd:source,stdio:'inherit',env});
 if(child.error)throw child.error;if(child.status!==0)process.exit(child.status||1);
 if(os==='darwin'){
  const helper=join(out,'backend','capture-macos');
  const native=spawnSync('xcrun',['--sdk','macosx','clang','-arch',arch==='amd64'?'x86_64':arch,
   '-mmacosx-version-min=12.0','-fobjc-arc','-O2','-Wall','-Wextra','-Werror',
   '-framework','AppKit','-framework','CoreText','-framework','ImageIO','-framework','UniformTypeIdentifiers',
   '-weak_framework','ScreenCaptureKit',join(source,'native','capture-macos.m'),join(source,'native','selection-view.m'),
   join(source,'native','overlay-annotations.m'),'-o',helper],
   {stdio:'inherit'});
  if(native.error)throw native.error;if(native.status!==0)process.exit(native.status||1);
  const signing=spawnSync('codesign',['--force','--sign','-','--identifier','com.sinan.screenshot.capture',helper],{stdio:'inherit'});
  if(signing.error)throw signing.error;if(signing.status!==0)process.exit(signing.status||1);
 }
 await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(`截图插件已构建：${target}；${budget.count} 个 UI 资源，${budget.bytes} 字节`);
}
