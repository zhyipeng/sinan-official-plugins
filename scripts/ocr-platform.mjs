import {join} from 'node:path';

export const engineCommit='63bef543c782a0d81db2af056e1dfba550c6dd87';
export const models={
 'PP-OCRv6_det_small.onnx':['det.onnx','090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f'],
 'PP-OCRv6_rec_small.onnx':['rec.onnx','6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884'],
 'dictionary.txt':['dictionary.txt','f7aa897ca828a4c7c9e2739c30f9161a33306d532f020bcdb91dcfb664a5507e'],
};

// Go's quoted.Split parses these flag strings; they never enter a shell.
export function cgoArg(value){
 if(!/[\s'"]/.test(value))return value;
 if(!value.includes("'"))return "'"+value+"'";
 if(!value.includes('"'))return '"'+value+'"';
 throw new Error('CGO 路径不能同时包含单引号和双引号');
}

export function platformPlan(target,toolchain){
 const [os,arch]=target.split('-');
 if(!['darwin','windows','linux'].includes(os)||!['arm64','amd64'].includes(arch))throw new Error('OCR 目标无效');
 const cmake=[],env={GOOS:os,GOARCH:arch},cflags=[],ldflags=[];
 let library,libraryDestination,extldflags='';
 if(os==='darwin'){
  cmake.push('-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0','-DCMAKE_OSX_ARCHITECTURES='+(arch==='arm64'?'arm64':'x86_64'));
  env.MACOSX_DEPLOYMENT_TARGET='12.0';cflags.push('-mmacosx-version-min=12.0');ldflags.push('-mmacosx-version-min=12.0');
  library='libppocr.5.0.0.dylib';libraryDestination='lib/libppocr.5.dylib';
  extldflags='-Wl,-rpath,@executable_path/../lib';
 }else if(os==='linux'){
  library='libppocr.so.5.0.0';libraryDestination='lib/libppocr.so.5';
  extldflags='-Wl,-rpath,$ORIGIN/../lib';
 }else{
  if(!toolchain)throw new Error('Windows 需要 --toolchain=<固定 LLVM-MinGW 目录>');
  const triple=(arch==='arm64'?'aarch64':'x86_64')+'-w64-mingw32';
  const compiler=join(toolchain,'bin',triple+'-clang.exe').replaceAll('\\','/');
  const cpp=join(toolchain,'bin',triple+'-clang++.exe').replaceAll('\\','/');
  cmake.push('-DCMAKE_C_COMPILER='+compiler,'-DCMAKE_CXX_COMPILER='+cpp,'-DCMAKE_SYSTEM_NAME=Windows','-DCMAKE_SYSTEM_PROCESSOR='+(arch==='arm64'?'aarch64':'x86_64'));
  env.CC=cgoArg(compiler);env.CXX=cgoArg(cpp);cflags.push('-DPPOCR_SHARED');
  library='libppocr.dll';libraryDestination='backend/libppocr.dll';
 }
 return {os,arch,cmake,env,cflags,ldflags,library,libraryDestination,extldflags,suffix:os==='windows'?'.exe':''};
}

// Patch only the build-owned copy, never the caller's upstream checkout.
// Both model and dictionary streams must use UTF-8 filesystem paths on Windows.
export function utf8Paths(file,text){
 const replacements=file.endsWith('onnx_lite.cpp')?
  [['std::ifstream in(file, std::ios::binary);','std::ifstream in(std::filesystem::u8path(file), std::ios::binary);']]:
  [['std::ifstream f(path);if(!f)Fail("cannot open dictionary "+path);','std::ifstream f(std::filesystem::u8path(path));if(!f)Fail("cannot open dictionary "+path);']];
 text=text.replaceAll('\r\n','\n');
 if(!text.includes('#include <fstream>\n'))throw new Error('上游文件缺少预期的 fstream 头');
 text=text.replace('#include <fstream>\n','#include <fstream>\n#include <filesystem>\n');
 for(const [before,after] of replacements){
  if(text.split(before).length!==2)throw new Error('上游路径实现已变化，拒绝盲目补丁');
  text=text.replace(before,after);
 }
 return text;
}
