import {build} from 'esbuild';
import {mkdir,rm,copyFile,readFile,writeFile,readdir,stat,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {hostTarget} from './targets.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),source=join(root,'plugins/ocr');
const args=new Map();
for(const argument of process.argv.slice(2)){
 const match=/^--(source|models|cmake|ninja|target)=(.+)$/.exec(argument);
 if(!match||args.has(match[1]))throw new Error('请使用 --source=<固定上游源码> --models=<模型目录>，可指定 --cmake、--ninja、--target');
 args.set(match[1],match[2]);
}
if(!args.has('source')||!args.has('models'))throw new Error('需要 --source 和 --models；不会自动下载或使用不明模型');
const target=args.get('target')||hostTarget();
if(target!==hostTarget())throw new Error('OCR 原生包必须在目标系统/架构构建，不能重命名本机产物');
if(process.platform!=='darwin')throw new Error('当前原生打包适配仅支持 macOS；Windows 的模型路径/DLL、Linux 运行库打包尚待验证，后台无界面测试仍支持三端');
const upstream=resolve(args.get('source')),models=resolve(args.get('models'));
function run(command,argv,options={}){
 const result=spawnSync(command,argv,{cwd:source,encoding:'utf8',...options});
 if(result.error)throw new Error(`无法执行 ${command}，请先安装构建依赖`);
 if(result.status!==0)throw new Error(`${command} 执行失败`);
 return result.stdout?.trim()||'';
}
const commit='63bef543c782a0d81db2af056e1dfba550c6dd87';
if(run('git',['-C',upstream,'rev-parse','HEAD'])!==commit||run('git',['-C',upstream,'status','--porcelain']))throw new Error('上游必须是未修改的 RapidOCRLite v5.0.0a6 固定提交；不会覆盖已有改动');
const expected={
 'PP-OCRv6_det_small.onnx':['det.onnx','090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f'],
 'PP-OCRv6_rec_small.onnx':['rec.onnx','6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884'],
 'dictionary.txt':['dictionary.txt','f7aa897ca828a4c7c9e2739c30f9161a33306d532f020bcdb91dcfb664a5507e'],
};
for(const [name,[,sha]] of Object.entries(expected))if(createHash('sha256').update(await readFile(join(models,name))).digest('hex')!==sha)throw new Error(`模型或字典摘要不符：${name}`);
const cache=join(root,'bin/ocr-native',target),staging=join(cache,'staging'),native=join(cache,'build');
await rm(staging,{recursive:true,force:true});
for(const name of ['backend','lib','models','ui'])await mkdir(join(staging,name),{recursive:true});
const cmake=args.get('cmake')||'cmake';
const configure=['-S',upstream,'-B',native,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0','-DCMAKE_OSX_ARCHITECTURES='+({amd64:'x86_64',arm64:'arm64'}[target.split('-')[1]]),'-DPPOCR_BUILD_STATIC=OFF','-DPPOCR_BUILD_SHARED=ON','-DPPOCR_BUILD_EXAMPLES=OFF','-DPPOCR_BUILD_TESTS=OFF','-DPPOCR_ENABLE_VULKAN=OFF','-DPPOCR_ENABLE_METAL=OFF','-DCMAKE_PROJECT_INCLUDE='+join(source,'native/strict-fp.cmake')];
if(args.has('ninja'))configure.push('-G','Ninja','-DCMAKE_MAKE_PROGRAM='+resolve(args.get('ninja')));
run(cmake,configure,{stdio:'inherit'});run(cmake,['--build',native,'--parallel','4'],{stdio:'inherit'});
await copyFile(join(native,'libppocr.5.0.0.dylib'),join(staging,'lib/libppocr.5.dylib'));
const goEnv={...process.env,GOOS:'darwin',GOARCH:target.split('-')[1],MACOSX_DEPLOYMENT_TARGET:'12.0'};
// These are cgo flag strings, never shell commands. Quote paths for cgo's parser.
const cgoArg=value=>{
 if(!/[\s'"]/.test(value))return value;
 if(!value.includes("'"))return "'"+value+"'";
 if(!value.includes('"'))return '"'+value+'"';
 throw new Error('CGO 构建路径不能同时包含单引号和双引号');
};
run('go',['build','-trimpath','-ldflags=-s -w','-o',join(staging,'backend/plugin'),'./backend'],{stdio:'inherit',env:{...goEnv,CGO_ENABLED:'0'}});
run('go',['build','-trimpath','-tags','ocr_native','-ldflags=-s -w -extldflags=-Wl,-rpath,@executable_path/../lib','-o',join(staging,'backend/ocr-worker'),'./worker'],{stdio:'inherit',env:{...goEnv,CGO_ENABLED:'1',CGO_CFLAGS:cgoArg('-I'+join(upstream,'include'))+' -mmacosx-version-min=12.0',CGO_LDFLAGS:cgoArg('-L'+native)+' -lppocr -mmacosx-version-min=12.0'}});
const probe=JSON.parse(run(join(staging,'backend/ocr-worker'),['--probe'],{env:{PPOCR_BENCH_THREADS:'4'}}));
if(probe.engine!=='RapidOCRLite 5.0.0a6')throw new Error('原生 ABI 检查失败');
for(const [name,[destination]] of Object.entries(expected))await copyFile(join(models,name),join(staging,'models',destination));
await build({entryPoints:[join(source,'ui/app.js')],outfile:join(staging,'ui/app.js'),bundle:true,format:'esm',platform:'browser',target:['safari16.4','chrome119','firefox115'],minify:true});
for(const name of ['index.html','style.css'])await copyFile(join(source,'ui',name),join(staging,'ui',name));
for(const name of ['manifest.json','icon.svg','THIRD_PARTY_NOTICES.txt'])await copyFile(join(source,name),join(staging,name));
await copyFile(join(root,'LICENSE'),join(staging,'LICENSE'));
await copyFile(join(run('go',['env','GOROOT']).trim(),'LICENSE'),join(staging,'GO-LICENSE.txt'));
await copyFile(join(upstream,'README.md'),join(staging,'UPSTREAM_README.md'));
await copyFile(join(source,'native/Apache-2.0.txt'),join(staging,'APACHE-2.0.txt'));
await writeFile(join(staging,'ENGINE.json'),JSON.stringify({commit,target,strictFP:true,minimumMacOS:'12.0',models:expected},null,2)+'\n');
let total=0,entries=0,uiTotal=0;
async function inspect(dir){for(const item of await readdir(dir,{withFileTypes:true})){
 if(item.isSymbolicLink())throw new Error('包内不允许符号链接');
 const file=join(dir,item.name);if(item.isDirectory()){await inspect(file);continue;}
 const bytes=(await stat(file)).size;total+=bytes;entries++;
 if(dir===join(staging,'ui')){if(bytes>512*1024)throw new Error('UI 单资源超过预算');uiTotal+=bytes;}
}}
await inspect(staging);if(total>64*1024*1024||entries>2048||uiTotal>2*1024*1024)throw new Error('OCR 包超过宿主预算');
const out=join(root,'bin/targets',target,'ocr');await mkdir(join(root,'bin/targets',target),{recursive:true});
await rm(out,{recursive:true,force:true});await rename(staging,out);
console.log(`OCR 已构建：${target}，${(total/1024/1024).toFixed(2)} MiB；仅本地构建，尚未发布或实机 UI 验收`);
