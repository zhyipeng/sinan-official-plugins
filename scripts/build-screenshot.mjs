import {build} from 'esbuild';
import {mkdir,rm,copyFile,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hostTarget,selectedTargets,screenshotTargets} from './targets.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=join(root,'plugins/screenshot');
const args=process.argv.slice(2);
if(!args.length&&!screenshotTargets.includes(hostTarget())){
 console.log('当前系统未提供截图插件，跳过');
 process.exit(0);
}
const targets=args.length===1&&args[0]==='--all'?screenshotTargets:selectedTargets(args);
if(targets.some(target=>!screenshotTargets.includes(target)))throw new Error('截图插件只支持 macOS 和 Windows');
if(targets.some(target=>target.startsWith('darwin-'))&&process.platform!=='darwin'){
 throw new Error('构建 macOS 截图包需要 Xcode Command Line Tools 和 macOS 14 或更新的 SDK');
}

function run(program,params,options={}){
 const child=spawnSync(program,params,{stdio:'inherit',...options});
 if(child.error)throw child.error;
 if(child.status!==0)throw new Error(`${program} 构建步骤失败`);
 return child.stdout;
}

let toolchain;
if(targets.some(target=>target.startsWith('windows-'))){
 toolchain=process.env.SINAN_SCREENSHOT_LLVM_MINGW;
 if(!toolchain){
  const python=process.platform==='win32'?'python':'python3';
  toolchain=run(python,[join(root,'scripts/prepare-screenshot-toolchain.py'),join(root,'bin/toolchains')],{
   stdio:['ignore','pipe','inherit'],encoding:'utf8',
  }).trim();
 }
 toolchain=resolve(toolchain);
}

async function buildWindowsHelper(arch,out){
 const triple=`${arch==='arm64'?'aarch64':'x86_64'}-w64-mingw32`;
 const compiler=join(toolchain,'bin',triple+'-clang++'+(process.platform==='win32'?'.exe':''));
 const native=join(source,'native','windows');
 run(compiler,['-std=c++17','-O2','-Wall','-Wextra','-Werror','-DUNICODE','-D_UNICODE','-DNOMINMAX',
  '-D_WIN32_WINNT=0x0A00','-DNTDDI_VERSION=0x0A000003','-municode','-mwindows','-static',
  ...['capture-windows.cpp','drawing.cpp','snap-targets.cpp'].map(name=>join(native,name)),
  '-lgdiplus','-lole32','-luuid','-ldwmapi','-lcomctl32','-lcomdlg32','-lshell32','-limm32',
  '-o',join(out,'backend','capture-windows.exe')]);
 const licenses=join(out,'RUNTIME-LICENSES');
 await mkdir(licenses);
 await copyFile(join(toolchain,'LICENSE.TXT'),join(licenses,'LLVM-LICENSE.txt'));
 for(const name of ['COPYING','COPYING.MinGW-w64.txt','COPYING.MinGW-w64-runtime.txt','COPYING.winpthreads.txt']){
  await copyFile(join(toolchain,triple,'share','mingw32',name),join(licenses,name));
 }
}

for(const target of targets){
 const [os,arch]=target.split('-');
 const out=join(root,'bin/targets',target,'screenshot');
 await rm(out,{recursive:true,force:true});
 await mkdir(join(out,'ui'),{recursive:true});
 await mkdir(join(out,'backend'),{recursive:true});
 await build({entryPoints:[join(source,'ui/app.js')],outfile:join(out,'ui/app.js'),bundle:true,format:'esm',
  platform:'browser',target:['safari16.4','chrome119'],minify:true});
 for(const name of ['index.html','style.css'])await copyFile(join(source,'ui',name),join(out,'ui',name));
 await copyFile(join(source,'icon.svg'),join(out,'icon.svg'));

 const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
 const suffix=os==='windows'?'.exe':'';
 manifest.runtime.entry='backend/plugin'+suffix;
 const env={...process.env,GOOS:os,GOARCH:arch,CGO_ENABLED:'0'};
 run('go',['build','-trimpath',...(os==='windows'?['-ldflags=-H=windowsgui']:[]),
  '-o',join(out,'backend/plugin'+suffix),'./backend'],{cwd:source,env});
 if(os==='darwin'){
  const helper=join(out,'backend','capture-macos');
  run('xcrun',['--sdk','macosx','clang','-arch',arch==='amd64'?'x86_64':arch,
   '-mmacosx-version-min=12.0','-fobjc-arc','-O2','-Wall','-Wextra','-Werror',
   '-framework','AppKit','-framework','ApplicationServices','-framework','CoreText','-framework','ImageIO',
   '-framework','UniformTypeIdentifiers','-weak_framework','ScreenCaptureKit',
   ...['capture-macos.m','selection-view.m','overlay-annotations.m','snap-targets.m'].map(name=>join(source,'native',name)),
   '-o',helper]);
  run('codesign',['--force','--sign','-','--identifier','com.sinan.screenshot.capture',helper]);
 }else{
  await buildWindowsHelper(arch,out);
 }
 await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(`截图插件已构建：${target}`);
}
