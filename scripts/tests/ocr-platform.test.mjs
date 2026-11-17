import test from 'node:test';
import assert from 'node:assert/strict';
import {platformPlan,cgoArg,utf8Paths} from '../ocr-platform.mjs';

test('Linux/macOS use relocatable library lookup, Windows uses matching toolchain and exe names',()=>{
 const linux=platformPlan('linux-arm64');assert.equal(linux.extldflags,'-Wl,-rpath,$ORIGIN/../lib');assert.equal(linux.libraryDestination,'lib/libppocr.so.5');
 const mac=platformPlan('darwin-amd64');assert.ok(mac.cmake.includes('-DCMAKE_OSX_ARCHITECTURES=x86_64'));assert.equal(mac.env.MACOSX_DEPLOYMENT_TARGET,'12.0');
 for(const arch of ['arm64','amd64']){
  const win=platformPlan('windows-'+arch,'C:/工具 链');assert.equal(win.suffix,'.exe');assert.equal(win.env.GOARCH,arch);assert.equal(win.libraryDestination,'backend/libppocr.dll');
  assert.ok(win.env.CC.includes((arch==='arm64'?'aarch64':'x86_64')+'-w64-mingw32-clang.exe'));
  assert.ok(win.cflags.includes('-DPPOCR_SHARED'));assert.equal(win.extldflags,'');
 }
 assert.throws(()=>platformPlan('windows-arm64'),/toolchain/);assert.throws(()=>platformPlan('linux-386'));
});

test('cgo flags keep a complete argument quoted, including Unicode paths',()=>{
 assert.equal(cgoArg('-IC:/中文 path/include'),"'-IC:/中文 path/include'");
 assert.equal(cgoArg('-L/tmp/plain'),'-L/tmp/plain');
 assert.throws(()=>cgoArg(`path with ' and "`));
});

test('UTF-8 stream patch handles CRLF and refuses unknown or ambiguous upstream code',()=>{
 const model='#include <fstream>\r\nstd::ifstream in(file, std::ios::binary);';
 const patched=utf8Paths('src/onnx_lite.cpp',model);assert.ok(patched.includes('std::filesystem::u8path(file)'));assert.ok(patched.includes('#include <filesystem>'));
 const dict='#include <fstream>\nstd::ifstream f(path);if(!f)Fail("cannot open dictionary "+path);';
 assert.ok(utf8Paths('src/ppocr.cpp',dict).includes('std::filesystem::u8path(path)'));
 assert.throws(()=>utf8Paths('src/onnx_lite.cpp',model+model));
 assert.throws(()=>utf8Paths('src/onnx_lite.cpp','#include <fstream>\nchanged stream;'));
 assert.ok(model.includes('\r\n')); // The caller's source remains unchanged.
});
