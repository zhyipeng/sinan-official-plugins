import {build} from 'esbuild';
import {mkdir,rm,copyFile,readFile,writeFile,readdir,stat,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {hostTarget} from './targets.mjs';
import {engineCommit,models as expected,platformPlan,cgoArg,utf8Paths} from './ocr-platform.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),source=join(root,'plugins/ocr');
const args=new Map();
for(const argument of process.argv.slice(2)){
 const match=/^--(source|models|cmake|ninja|target|toolchain)=(.+)$/.exec(argument);
 if(!match||args.has(match[1]))throw new Error('请指定 --source、--models，可指定 --cmake、--ninja、--target、--toolchain');
 args.set(match[1],match[2]);
}
if(!args.has('source')||!args.has('models'))throw new Error('需要固定上游 --source 和 --models；可先运行 scripts/prepare-ocr.py');
const target=args.get('target')||hostTarget();
if(target!==hostTarget())throw new Error('OCR 完整包必须在对应 OS/架构运行构建与 probe，不能重命名本机产物');
const toolchain=args.has('toolchain')?resolve(args.get('toolchain')):undefined;
const plan=platformPlan(target,toolchain),upstream=resolve(args.get('source')),models=resolve(args.get('models'));
function run(command,argv,options={}){
 const result=spawnSync(command,argv,{cwd:source,encoding:'utf8',windowsHide:true,...options});
 if(result.error)throw new Error(`无法执行 ${command}，请先安装构建依赖`);
 if(result.status!==0)throw new Error(`${command} 执行失败`);
 return result.stdout?.trim()||'';
}
if(run('git',['-C',upstream,'rev-parse','HEAD'])!==engineCommit||run('git',['-C',upstream,'status','--porcelain']))throw new Error('上游必须是未修改的固定提交；不会覆盖已有改动');
for(const [name,[,sha]] of Object.entries(expected))if(createHash('sha256').update(await readFile(join(models,name))).digest('hex')!==sha)throw new Error(`模型或字典摘要不符：${name}`);
const cache=join(root,'bin/ocr-native',target),staging=join(cache,'staging-v2'),native=join(cache,'build-v2'),privateSource=join(cache,'source-v2');
await rm(staging,{recursive:true,force:true});await rm(privateSource,{recursive:true,force:true});
for(const name of ['backend','lib','models','ui'])await mkdir(join(staging,name),{recursive:true});
// Copy tracked CPU source only. The caller's checkout and vendored executables
// are never patched or executed. Keep UTF-8 changes in this build-owned copy.
const tracked=run('git',['-C',upstream,'ls-files','-z']).split('\0').filter(Boolean);
for(const name of tracked){
 if(name.startsWith('third_party/'))continue;
 const destination=join(privateSource,name);await mkdir(dirname(destination),{recursive:true});await copyFile(join(upstream,name),destination);
}
for(const name of ['src/ppocr.cpp','src/onnx_lite.cpp']){
 const path=join(privateSource,name);await writeFile(path,utf8Paths(name,await readFile(path,'utf8')));
}
const cmake=args.get('cmake')||'cmake';
const configure=['-S',privateSource,'-B',native,'-DCMAKE_BUILD_TYPE=Release',...plan.cmake,'-DPPOCR_BUILD_STATIC=OFF','-DPPOCR_BUILD_SHARED=ON','-DPPOCR_BUILD_EXAMPLES=OFF','-DPPOCR_BUILD_TESTS=OFF','-DPPOCR_ENABLE_VULKAN=OFF','-DPPOCR_ENABLE_METAL=OFF','-DCMAKE_PROJECT_INCLUDE='+join(source,'native/strict-fp.cmake')];
if(args.has('ninja'))configure.push('-G','Ninja','-DCMAKE_MAKE_PROGRAM='+resolve(args.get('ninja')));
if(plan.os==='windows'&&!args.has('ninja'))configure.push('-G','Ninja');
run(cmake,configure,{stdio:'inherit'});run(cmake,['--build',native,'--parallel','4'],{stdio:'inherit'});
await copyFile(join(native,plan.library),join(staging,plan.libraryDestination));
const runtimeLibraries=[];
if(plan.os==='windows'){
 // All imported non-system DLLs must come from the matching target runtime.
 const triple=(plan.arch==='arm64'?'aarch64':'x86_64')+'-w64-mingw32';
 const system=/^(api-ms-|ext-ms-|kernel32\.dll$|ntdll\.dll$|ucrtbase\.dll$|msvcrt\.dll$|advapi32\.dll$|bcrypt\.dll$|user32\.dll$|shell32\.dll$|ole32\.dll$|ws2_32\.dll$|secur32\.dll$)/i;
 const runtime=/^(libc\+\+|libunwind|libwinpthread-1)\.dll$/i;
 const pending=[join(staging,plan.libraryDestination)],seen=new Set();
 while(pending.length){
  const file=pending.pop();
  const dump=run(join(toolchain,'bin','llvm-objdump.exe'),['-p',file]);
  for(const match of dump.matchAll(/DLL Name:\s*(\S+)/g)){
   const name=match[1];if(system.test(name)||seen.has(name.toLowerCase()))continue;
   if(!runtime.test(name))throw new Error(`未声明的 Windows 原生依赖：${name}`);
   seen.add(name.toLowerCase());
   const destination=join(staging,'backend',name);
   await copyFile(join(toolchain,triple,'bin',name),destination);pending.push(destination);runtimeLibraries.push(name);
  }
 }
 // LLVM-MinGW distributes the full runtime license bundle with each toolchain.
 const licenseDestination=join(staging,'RUNTIME-LICENSES');await mkdir(licenseDestination,{recursive:true});
 await copyFile(join(toolchain,'LICENSE.TXT'),join(licenseDestination,'LLVM-LICENSE.txt'));
 for(const name of ['COPYING','COPYING.winpthreads.txt','COPYING.MinGW-w64.txt','COPYING.MinGW-w64-runtime.txt'])await copyFile(join(toolchain,triple,'share','mingw32',name),join(licenseDestination,name));
}
const goEnv={...process.env,...plan.env};
const cflags=[cgoArg('-I'+join(privateSource,'include').replaceAll('\\','/')),...plan.cflags].join(' ');
const ldflags=[cgoArg('-L'+native.replaceAll('\\','/')),'-lppocr',...plan.ldflags].join(' ');
run('go',['build','-trimpath','-ldflags=-s -w','-o',join(staging,'backend/plugin'+plan.suffix),'./backend'],{stdio:'inherit',env:{...goEnv,CGO_ENABLED:'0'}});
const linker='-s -w'+(plan.extldflags?' -extldflags='+plan.extldflags:'');
run('go',['build','-trimpath','-tags','ocr_native','-ldflags='+linker,'-o',join(staging,'backend/ocr-worker'+plan.suffix),'./worker'],{stdio:'inherit',env:{...goEnv,CGO_ENABLED:'1',CGO_CFLAGS:cflags,CGO_LDFLAGS:ldflags}});
const probeEnv={PPOCR_BENCH_THREADS:'4'};
for(const key of ['SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR'])if(process.env[key])probeEnv[key]=process.env[key];
const probe=JSON.parse(run(join(staging,'backend/ocr-worker'+plan.suffix),['--probe'],{env:probeEnv}));
if(probe.engine!=='RapidOCRLite 5.0.0a6')throw new Error('原生 ABI 检查失败');
for(const [name,[destination]] of Object.entries(expected))await copyFile(join(models,name),join(staging,'models',destination));
await build({entryPoints:[join(source,'ui/app.js')],outfile:join(staging,'ui/app.js'),bundle:true,format:'esm',platform:'browser',target:['safari16.4','chrome119','firefox115'],minify:true});
for(const name of ['index.html','style.css'])await copyFile(join(source,'ui',name),join(staging,'ui',name));
for(const name of ['icon.svg','THIRD_PARTY_NOTICES.txt'])await copyFile(join(source,name),join(staging,name));
const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));manifest.runtime.entry='backend/plugin'+plan.suffix;
await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await copyFile(join(root,'LICENSE'),join(staging,'LICENSE'));
await copyFile(join(run('go',['env','GOROOT']),'LICENSE'),join(staging,'GO-LICENSE.txt'));
await copyFile(join(upstream,'README.md'),join(staging,'UPSTREAM_README.md'));
await copyFile(join(source,'native/Apache-2.0.txt'),join(staging,'APACHE-2.0.txt'));
await writeFile(join(staging,'ENGINE.json'),JSON.stringify({commit:engineCommit,target,strictFP:true,utf8FilesystemPaths:true,minimumMacOS:plan.os==='darwin'?'12.0':undefined,linuxBaseline:plan.os==='linux'?'Ubuntu 24.04 / glibc 2.39':undefined,runtimeLibraries,probe,models:expected},null,2)+'\n');
let total=0,entries=0,uiTotal=0;
async function inspect(dir){for(const item of await readdir(dir,{withFileTypes:true})){
 if(item.isSymbolicLink())throw new Error('包内不允许符号链接');
 const file=join(dir,item.name);if(item.isDirectory()){await inspect(file);continue;}
 const bytes=(await stat(file)).size;total+=bytes;entries++;
 if(dir===join(staging,'ui')){if(bytes>512*1024)throw new Error('UI 单资源超过预算');uiTotal+=bytes;}
}}
await inspect(staging);if(total>64*1024*1024||entries>2048||uiTotal>2*1024*1024)throw new Error('OCR 包超过宿主预算');
const out=join(root,'bin/targets',target,'ocr');await mkdir(dirname(out),{recursive:true});
await rm(out,{recursive:true,force:true});await rename(staging,out);
console.log(`OCR 已构建并通过 ABI probe：${target}，${(total/1024/1024).toFixed(2)} MiB；原生识别与 UI 验证分别记录`);
