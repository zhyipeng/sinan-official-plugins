import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../ui/app.js',import.meta.url),'utf8')).replace(/^import [^\r\n]*;\r?\n/,'');
const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,3));}throw new Error('界面状态未完成');};
function fixture(options={}){
 const nodes=new Map(),events={},calls=[],copies=[],imageCalls=[];let startResolve;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',dataset:{},disabled:false,hidden:false,selectionStart:0,selectionEnd:0,events:{},addEventListener(k,f){this.events[k]=f;}});return nodes.get(id);};
 const context={document:{getElementById:node,visibilityState:'visible',addEventListener(k,f){events[k]=f;}},window:{addEventListener(k,f){events[k]=f;}},ready(){},readLaunch:async()=>options.launch||{},readClipboardImage:async()=>options.nonImage?null:({url:'sinan-plugin://tools.ocr/clipboard.png'}),executeImage:async(id,url)=>{imageCalls.push(url);return context.execute(id,'');},setTimeout(fn){return setTimeout(fn,1);},writeClipboardText:async text=>{if(options.copyFails)throw new Error();copies.push(text);},execute:async(id,input)=>{
  calls.push({id,input});let data;
  if(id==='start')data=options.delayedStart?await new Promise(resolve=>{startResolve=resolve;}):{id:'a'.repeat(32),state:'running'};
  else if(id==='poll')data=options.pending?{state:'running'}:{state:'done',text:'合成 OCR 文字'};
  else data={state:'cancelled'};
  return {text:JSON.stringify(data)};
 }};
 vm.runInNewContext(source,context);
 return {node,events,calls,copies,imageCalls,context,releaseStart:value=>startResolve(value)};
}
test('普通打开不读取图片，显式识别后展示并复制可编辑结果',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);f.node('start').events.click();
 await wait(()=>f.node('output').value==='合成 OCR 文字');
 f.node('output').value='修改后的文字';f.node('output').events.input();await f.node('copy').events.click();
 assert.deepEqual(f.copies,['修改后的文字']);assert.equal(f.node('status').textContent,'已复制');
 assert.ok(f.calls.some(c=>c.id==='cancel'));assert.equal(f.node('start').disabled,false);
});
test('取消发生在 start 返回前，迟到任务仍被撤销且不覆盖文本',async()=>{
 const f=fixture({delayedStart:true});f.node('start').events.click();await wait(()=>f.calls.some(c=>c.id==='start'));
 await f.node('cancel').events.click();f.releaseStart({id:'b'.repeat(32),state:'running'});
 await wait(()=>f.calls.some(c=>c.id==='cancel'));assert.equal(f.node('output').value,'');
 assert.equal(f.calls.filter(c=>c.id==='poll').length,0);
});
test('视图隐藏停止轮询并取消任务，复制失败显示错误',async()=>{
 const f=fixture({pending:true,copyFails:true});f.node('start').events.click();await wait(()=>f.calls.some(c=>c.id==='poll'));
 f.context.document.visibilityState='hidden';f.events.visibilitychange();await wait(()=>f.calls.some(c=>c.id==='cancel'));
 const count=f.calls.filter(c=>c.id==='poll').length;await new Promise(r=>setTimeout(r,8));assert.equal(f.calls.filter(c=>c.id==='poll').length,count);
 f.node('output').value='result';f.node('output').events.input();await f.node('copy').events.click();assert.equal(f.node('status').dataset.error,'true');
});
test('清单使用已有桥、独立剪贴板权限并声明会话图片匹配',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
 assert.deepEqual(manifest.permissions,['clipboard.read']);assert.deepEqual(manifest.contributes.uiViews[0].permissions,['clipboard.write','clipboard.read']);
 assert.equal(manifest.contributes.uiViews[0].bridgeVersion,'2');assert.deepEqual(manifest.contributes.commands[0].inputMatchers,[{kind:'image'}]);
});

test('主搜索图片打开后预览同一图片并自动识别，不读取新的剪贴板',async()=>{
 const f=fixture({launch:{image:{url:'sinan-plugin://tools.ocr/launch.png'}}});
 await wait(()=>f.node('output').value==='合成 OCR 文字');
 assert.equal(f.node('preview').src,'sinan-plugin://tools.ocr/launch.png');
 assert.deepEqual(f.imageCalls,['sinan-plugin://tools.ocr/launch.png']);
 assert.equal(f.node('original').hidden,false);
});
test('粘贴图片自动识别，普通文本保留原生粘贴',async()=>{
 const f=fixture();let prevented=0;
 f.events.paste({clipboardData:{items:[{kind:'string',type:'text/plain'}]},preventDefault(){prevented++;}});
 assert.equal(f.calls.length,0);
 f.events.paste({clipboardData:{items:[{kind:'file',type:'image/png'}]},preventDefault(){prevented++;}});
 await wait(()=>f.node('output').value==='合成 OCR 文字');
 assert.equal(prevented,1);assert.equal(f.node('preview').src,f.imageCalls[0]);
});
test('Cmd/Ctrl+C 复制编辑结果，选区、IME 与其他组合键保持原生行为',async()=>{
 const f=fixture();f.node('output').value='edited';let prevented=0;
 const key={key:'c',ctrlKey:true,preventDefault(){prevented++;}};
 f.events.keydown(key);await wait(()=>f.copies.length===1);
 assert.deepEqual(f.copies,['edited']);assert.equal(prevented,1);
 f.context.document.activeElement=f.node('output');f.node('output').selectionEnd=2;f.events.keydown(key);
 f.node('output').selectionEnd=0;f.events.keydown({...key,isComposing:true});
 f.events.keydown({...key,shiftKey:true});assert.equal(prevented,1);
 f.events.keydown({...key,ctrlKey:false,metaKey:true});await wait(()=>f.copies.length===2);
});

test('Cmd/Ctrl+V 即使没有文件粘贴事件也能识别，文本剪贴板保持原生行为',async()=>{
 for(const modifier of ['ctrlKey','metaKey']){
  const f=fixture();f.events.keydown({key:'v',[modifier]:true,preventDefault(){throw new Error('text paste was intercepted');}});
  await wait(()=>f.node('output').value==='合成 OCR 文字');assert.equal(f.imageCalls.length,1);
 }
 const f=fixture({nonImage:true});f.events.keydown({key:'v',ctrlKey:true});
 await new Promise(r=>setTimeout(r,5));assert.equal(f.calls.length,0);
 assert.notEqual(f.node('status').dataset.error,'true');
});
