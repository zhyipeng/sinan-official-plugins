// Exercise the real page and bridge flow without a browser, display or system clipboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['plugins/screenshot/ui/app.js'],bundle:true,write:false,format:'iife',plugins:[{name:'fake-host',setup(b){
 b.onResolve({filter:/third_party\/sinan\/packages\/plugin-sdk\/ui\/index.js$/},()=>({path:'bridge',namespace:'fixture'}));
 b.onResolve({filter:/^\.\/editor\.js$/},()=>({path:'editor',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='editor'?'export const createEditor=(...args)=>globalThis.makeEditor(...args);':'export const ready=()=>{};export const execute=(...args)=>globalThis.host(...args);export const executeHidden=(...args)=>globalThis.host(...args);export const readLaunch=()=>globalThis.launch();export const showWindow=()=>globalThis.host("show-window");export const hideWindow=()=>globalThis.host("hide-window");export const savePNG=(...args)=>globalThis.savePNG(...args);export const openImage=()=>globalThis.openImage();export const readClipboardImage=()=>globalThis.readClipboardImage();export const readDependencies=()=>globalThis.dependencies();export const stageDependencyImage=(...args)=>globalThis.stageDependencyImage(...args);export const openDependency=(...args)=>globalThis.openDependency(...args);export const discardDependencyImage=(...args)=>globalThis.discardDependencyImage(...args);export const openDependencyManager=()=>globalThis.openDependencyManager();'}));
}}]});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({launch='open',slow=false,decodeFailure=false,copyFailure=false,saved=true,external=null,externalFailure=false,slowExternal=false,ocrState="available",handoffFailure=false}={}){
 const elements=new Map(),draws=[],commands=[],timers=[],globalHandlers={};let failure=false,finish,finishExternal;const editorCalls=[];
 const drawing=new Proxy({},{get:(_,name)=>(...args)=>draws.push([name,...args]),set:()=>true});
 function element(id){if(!elements.has(id))elements.set(id,{handlers:{},dataset:{},value:id==='width'?'6':id==='color'?'#e5484d':'',hidden:false,disabled:false,textContent:'',addEventListener(type,fn){this.handlers[type]=fn;},setAttribute(){},focus(){},getContext(){return drawing;},getBoundingClientRect(){return {left:0,top:0,width:100,height:50};},setPointerCapture(){},releasePointerCapture(){},toBlob(fn){fn(new Blob([Uint8Array.from([1,2,3])],{type:'image/png'}));}});return elements.get(id);}
 const tools=['arrow','rect','text'].map(tool=>{const e=element(`tool-${tool}`);e.dataset.tool=tool;return e;});
 const win={addEventListener(type,fn){globalHandlers[type]=fn;},getSelection:()=>''};
 vm.runInNewContext(bundle.outputFiles[0].text,{Image:class{async decode(){if(decodeFailure)throw new Error("PNG 解码失败");}},Blob,Uint8Array,atob,btoa,Math,Number,JSON,Error,Promise,document:{getElementById:element,querySelectorAll:()=>tools,addEventListener(type,fn){globalHandlers[type]=fn;}},window:win,setTimeout(fn){timers.push(fn);},createImageBitmap:async()=>{if(decodeFailure)throw new Error('PNG 解码失败');return {width:1000,height:500,close(){}};},makeEditor:(holder,change)=>({load(bitmap){editorCalls.push('load');change(bitmap.width,bitmap.height);},async exportPNG(){editorCalls.push('export');return new Blob([Uint8Array.from([1,2,3])],{type:'image/png'});},setBusy(value){editorCalls.push(['busy',value]);},undo(){editorCalls.push('undo');},redo(){editorCalls.push('redo');},destroy(){editorCalls.push('destroy');}}),dependencies:async()=>[{id:"ocr",state:ocrState,message:"OCR 需要安装或更新"}],stageDependencyImage:async(...args)=>{commands.push(["stage-ocr",...args]);return "image-handle";},openDependency:async(...args)=>{commands.push(["open-ocr",...args]);if(handoffFailure)throw new Error("目标打开失败");},discardDependencyImage:async(id)=>commands.push(["discard-ocr",id]),openDependencyManager:async()=>commands.push(["manage-dependency"]),openImage:async()=>{commands.push(["open-image"]);if(slowExternal)await new Promise(resolve=>{finishExternal=resolve;});if(externalFailure)throw new Error("图片无效");return external;},readClipboardImage:async()=>{commands.push(["read-clipboard-image"]);return external;},savePNG:async()=>({saved}),launch:async()=>({commandId:launch}),host:async(id,input)=>{
  commands.push([id,input]);let value={};if(id==='copy'&&copyFailure)throw new Error('剪贴板写入失败');if(id==='capture-region'){if(slow)await new Promise(resolve=>{finish=resolve;});value=failure?{state:'failed',error:'模拟取消'}:{state:'done',id:'job',size:3};}if(id==='poll')value=failure?{state:'failed',error:'模拟取消'}:{state:'done',size:3};if(id==='read')value={data:'AQID'};if(id==='upload-start')value={id:'upload'};if(id==='save')value={path:'/Pictures/Sinan/test.png'};return {text:JSON.stringify(value)};
 }});
 return {element,draws,commands,editorCalls,globalHandlers,async tick(){timers.shift()?.();await settle();},failDecode(){decodeFailure=true;},async finishExternal(){finishExternal();await settle();},async finishCapture(){finish();await settle();},fail(){failure=true;},async click(id){element(id).handlers.click();await settle();},async capture(){await this.click('start');await settle();await settle();},pointer(type,x,y){element('canvas').handlers[type]({clientX:x,clientY:y,pointerId:1,button:0});},tool(tool){tools.find(e=>e.dataset.tool===tool).handlers.click();}};
}
test('截图自动交给编辑组件，复制保存继续经过原有后台桥',async()=>{
 const app=fixture();await app.capture();assert.equal(app.element('dimensions').textContent,'1000 × 500');assert.equal(app.element('copy').disabled,false);assert.equal(app.editorCalls.filter(c=>c==='load').length,1);assert.ok(app.commands.some(c=>c[0]==='show-window'));
 await app.click('copy');await settle();assert.ok(app.commands.some(c=>c[0]==='upload'&&c[1]==='upload:0:AQID'));assert.ok(app.commands.some(c=>c[0]==='copy'&&c[1]==='upload'));assert.equal(app.element('status').textContent,'已复制并关闭');assert.ok(app.commands.some(c=>c[0]==='hide-window'));
 await app.click('save');await settle();assert.match(app.element('status').textContent,/已保存/);app.globalHandlers.pagehide();assert.ok(app.editorCalls.includes('destroy'));
});
test('未取得新图片不会将空图交给编辑组件',async()=>{
 const app=fixture();await app.capture();app.fail();await app.capture();assert.equal(app.element('status').textContent,'模拟取消');assert.ok(app.commands.some(c=>c[0]==='hide-window'));assert.equal(app.element('dimensions').textContent,'1000 × 500');assert.equal(app.editorCalls.filter(c=>c==='load').length,1);
});
test('页面退出后的迟到截图不会写回页面，并释放原图任务',async()=>{
 const app=fixture({slow:true});await app.click('start');app.globalHandlers.pagehide();await app.finishCapture();assert.ok(app.commands.some(c=>c[0]==='cancel'&&c[1]==='job'));assert.equal(app.element('dimensions').textContent,'');
});
test('截图入口自动执行隐藏捕获，后处理入口只显示编辑器',async()=>{
 const direct=fixture({launch:'capture'});await settle();await settle();assert.equal(direct.commands.filter(c=>c[0]==='capture-region').length,1);assert.equal(direct.element('dimensions').textContent,'1000 × 500');
 const editor=fixture();await settle();assert.equal(editor.commands.length,0);assert.equal(editor.element('dimensions').textContent,'');
});

test('搜索双入口和全局热键使用同一隐藏截图命令',async()=>{
 const mf=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
 const visible=mf.contributes.commands.filter(c=>!c.searchOnly);
 assert.deepEqual(visible.map(c=>c.title),['截图','截图后处理']);
 assert.equal(visible[0].id,'capture');assert.equal(visible[0].startHidden,true);assert.equal(visible[0].shortcut,'CmdOrCtrl+Shift+A');assert.equal(visible[0].uiView,visible[1].uiView);assert.ok(!visible[1].startHidden);
 assert.ok(mf.contributes.uiViews[0].permissions.includes('window.execute'));assert.ok(mf.contributes.uiViews[0].commands.includes('capture-region'));
});
test('Command/Ctrl 快捷键交给编辑器和导出桥，文字输入和输入法保持原行为',async()=>{
 const app=fixture();await app.capture();
 const key=(value,extra={})=>app.globalHandlers.keydown({key:value,metaKey:true,ctrlKey:false,altKey:false,isComposing:false,shiftKey:false,target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){},...extra});
 key('z');key('z',{metaKey:false,ctrlKey:true,shiftKey:true});assert.ok(app.editorCalls.includes('undo'));assert.ok(app.editorCalls.includes('redo'));
 const before=app.editorCalls.length;key('z',{isComposing:true});key('z',{target:{closest:()=>({})}});assert.equal(app.editorCalls.length,before);
 key('c');await settle();await settle();assert.equal(app.element('status').textContent,'已复制并关闭');key('s');await settle();await settle();assert.match(app.element('status').textContent,/已保存/);
});

test('PNG 解码失败只隐藏窗口，不显示后处理',async()=>{
 const app=fixture({launch:'capture',decodeFailure:true});await settle();await settle();await settle();
 assert.ok(app.commands.some(c=>c[0]==='hide-window'));assert.ok(!app.commands.some(c=>c[0]==='show-window'));assert.equal(app.editorCalls.filter(c=>c==='load').length,0);
});
test('复制失败不关闭窗口，保存取消不报告成功',async()=>{
 const app=fixture({copyFailure:true,saved:false});await app.capture();await app.click('copy');
 assert.equal(app.element('status').textContent,'剪贴板写入失败');assert.ok(!app.commands.some(c=>c[0]==='hide-window'));
 await app.click('save');assert.equal(app.element('status').textContent,'已取消保存');assert.equal(app.element('copy').disabled,false);
});

test('后处理独立导入图片，无需先截图',async()=>{
 const app=fixture({external:{url:'sinan-plugin://tools.screenshot/input.png'}});await app.click('import');await settle();
 assert.equal(app.element('status').textContent,'图片已导入');assert.equal(app.element('copy').disabled,false);assert.equal(app.editorCalls.filter(c=>c==='load').length,1);assert.ok(!app.commands.some(c=>c[0]==='capture-region'));
});
test('Cmd/Ctrl+V 及原生粘贴事件读取图片，文本输入保留原生行为',async()=>{
 for(const mac of [true,false]){
  const app=fixture({external:{url:'sinan-plugin://tools.screenshot/input.png'}});
  const event={key:'v',metaKey:mac,ctrlKey:!mac,altKey:false,isComposing:false,target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){}};
  app.globalHandlers.keydown(event);await settle();await settle();assert.equal(app.element('status').textContent,'图片已粘贴');
  const before=app.commands.length;app.globalHandlers.keydown({...event,target:{closest:()=>({})}});app.globalHandlers.keydown({...event,isComposing:true});assert.equal(app.commands.length,before);
  app.globalHandlers.paste(event);await settle();assert.equal(app.commands.filter(c=>c[0]==='read-clipboard-image').length,2);
  app.globalHandlers.paste({...event,target:{closest:()=>({})}});assert.equal(app.commands.filter(c=>c[0]==='read-clipboard-image').length,2);
 }
});
test('取消导入、无图片、坏图片保留当前编辑内容',async()=>{
 for(const opts of [{},{externalFailure:true},{failAfterCapture:true,external:{url:'sinan-plugin://tools.screenshot/input.png'}}]){
  const app=fixture(opts);
  await app.capture();if(opts.failAfterCapture)app.failDecode();
  const before=app.editorCalls.filter(c=>c==='load').length;
  await app.click('import');await settle();assert.equal(app.editorCalls.filter(c=>c==='load').length,before);assert.ok(!app.commands.some(c=>c[0]==='hide-window'));
  assert.equal(app.element('copy').disabled,false);
 }
});
test('退出后的导入结果不写回页面',async()=>{
 const app=fixture({slowExternal:true,external:{url:'sinan-plugin://tools.screenshot/input.png'}});await app.click('import');app.globalHandlers.pagehide();await app.finishExternal();assert.equal(app.editorCalls.filter(c=>c==='load').length,0);
});

test('剪贴板无图片时保留已有图片',async()=>{
 const app=fixture();await app.capture();app.globalHandlers.paste({target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){}});await settle();assert.equal(app.element('status').textContent,'剪贴板中没有图片');assert.equal(app.editorCalls.filter(c=>c==='load').length,1);assert.equal(app.element('copy').disabled,false);
});

test('OCR 交出当前编辑 PNG 并跳转公开入口',async()=>{
 const app=fixture();await app.capture();await app.click('ocr');await settle();
 assert.ok(app.commands.some(c=>c[0]==='stage-ocr'&&c[1]==='ocr'&&c[2]==='recognize-image'&&c[3] instanceof Blob));
 assert.ok(app.commands.some(c=>c[0]==='open-ocr'&&c[1]==='ocr'&&c[2]==='recognize-image'&&c[3].imageHandle==='image-handle'));
});
test('缺少或禁用 OCR 保留图片并给出插件中心入口',async()=>{
 for(const ocrState of ['missing','disabled','incompatible']){const app=fixture({ocrState});await app.capture();await app.click('ocr');assert.equal(app.element('manage-dependency').hidden,false);assert.equal(app.element('copy').disabled,false);assert.ok(!app.commands.some(c=>c[0]==='stage-ocr'));await app.click('manage-dependency');assert.ok(app.commands.some(c=>c[0]==='manage-dependency'));}
});
test('目标打开失败保留编辑器并释放上传句柄',async()=>{
 const app=fixture({handoffFailure:true});await app.capture();await app.click('ocr');await settle();assert.equal(app.element('status').textContent,'目标打开失败');assert.equal(app.element('copy').disabled,false);assert.ok(app.commands.some(c=>c[0]==='discard-ocr'));assert.ok(!app.commands.some(c=>c[0]==='hide-window'));
});
