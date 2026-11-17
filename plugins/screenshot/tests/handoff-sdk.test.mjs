import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const code=(await readFile(new URL('../../../third_party/sinan/packages/plugin-sdk/ui/index.js',import.meta.url),'utf8')).replaceAll('export ','')+'\nglobalThis.sdk={stageDependencyImage,openDependency};';
function fixture(fail=false){
 const calls=[];const data=[];let offset=0;
 const context={Uint8Array,Blob,btoa,window:{webkit:{messageHandlers:{sinanCall:{postMessage:async req=>{
  calls.push(req);if(req.method==='image.upload.start')return {id:'a'.repeat(32)};
  if(req.method==='image.upload.chunk'){
   if(fail)throw new Error('upload failed');
   assert.ok(JSON.stringify(req).length<64*1024);
   const [id,position,encoded]=req.input.split(':');assert.equal(id,'a'.repeat(32));assert.equal(Number(position),offset);
   const block=Buffer.from(encoded,'base64');data.push(block);offset+=block.length;return null;
  }
  if(req.method==='image.upload.finish')return {imageHandle:'a'.repeat(32)};
  return null;
 }}}}}};vm.runInNewContext(code,context);return {sdk:context.sdk,calls,data};
}
test('真实 SDK 有界分块交接图片，不产生单个大请求',async()=>{
 const f=fixture();const image=Uint8Array.from({length:1024*1024+7},(_,i)=>i%251);
 const handle=await f.sdk.stageDependencyImage('ocr','recognize-image',new Blob([image]));assert.equal(handle,'a'.repeat(32));assert.deepEqual(Buffer.concat(f.data),Buffer.from(image));
 await f.sdk.openDependency('ocr','recognize-image',{imageHandle:handle});assert.equal(f.calls.at(-1).method,'dependency.open');assert.equal(f.calls.at(-1).input,'ocr');assert.equal(f.calls.at(-1).value.entryId,'recognize-image');
});
test('真实 SDK 拒绝超限图片并清理中断上传',async()=>{
 const f=fixture(true);await assert.rejects(f.sdk.stageDependencyImage('ocr','recognize-image',new Blob(['PNG'])),/upload failed/);assert.equal(f.calls.at(-1).method,'image.upload.cancel');
 const before=f.calls.length;await assert.rejects(f.sdk.stageDependencyImage('ocr','recognize-image',new Blob([new Uint8Array(4*1024*1024+1)])),/4 MiB/);assert.equal(f.calls.length,before);
});
