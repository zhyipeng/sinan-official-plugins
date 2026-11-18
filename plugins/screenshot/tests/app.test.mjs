import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';

const bundle=await build({entryPoints:['plugins/screenshot/ui/app.js'],bundle:true,write:false,format:'iife',plugins:[{
 name:'fake-host',setup(builder){
  builder.onResolve({filter:/plugin-sdk\/ui\/index\.js$/},()=>({path:'bridge',namespace:'fixture'}));
  builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:[
   'ready','execute','executeHidden','showWindow','hideWindow','readDependencies',
   'stageDependencyImage','openDependency','discardDependencyImage','openDependencyManager',
  ].map(name=>`export const ${name}=(...args)=>globalThis.host('${name}',...args);`).join('\n')}));
 },
}]});
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function fixture({action='ocr',dependency='available',rejectOpen=false}={}){
 const elements=new Map(),calls=[];
 function element(id){
  if(!elements.has(id))elements.set(id,{hidden:['manage','actions'].includes(id),handlers:{},
   addEventListener(type,fn){this.handlers[type]=fn;}});
  return elements.get(id);
 }
 vm.runInNewContext(bundle.outputFiles[0].text,{
  window:{addEventListener(){}},document:{getElementById:element},Blob,atob,Uint8Array,Error,
  async host(name,...args){
   calls.push([name,...args]);
   if(name==='executeHidden')return {text:JSON.stringify({action,id:'ticket',size:3})};
   if(name==='execute')return {text:JSON.stringify(args[0]==='read'?{data:'AQID'}:{state:'done'})};
   if(name==='readDependencies')return [{id:'ocr',state:dependency,message:'请安装 OCR 插件'}];
   if(name==='stageDependencyImage')return 'staged';
   if(name==='openDependency'&&rejectOpen)throw new Error('打开 OCR 失败');
  },
 });
 return {element,calls};
}

test('截图是唯一公开入口，保留隐藏启动和 OCR 交接',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
 assert.deepEqual(manifest.contributes.commands.filter(command=>!command.searchOnly).map(command=>command.id),['capture']);
 assert.equal(manifest.contributes.commands[0].startHidden,true);
 const [view]=manifest.contributes.uiViews;
 assert.deepEqual(view.permissions,['window.execute','window.show','window.hide']);
 assert.deepEqual(view.dependencies,['ocr']);
});

test('原生复制和保存后无需加载网页内容或 OCR',async()=>{
 const app=fixture({action:'completed'});
 await settle();
 assert.deepEqual(app.calls.map(([name])=>name),['ready','executeHidden']);
});

test('OCR 接收 PNG 并在已显示的窗口打开',async()=>{
 const app=fixture();
 await settle();
 assert.deepEqual(app.calls.map(([name])=>name),['ready','executeHidden','readDependencies','execute',
  'stageDependencyImage','showWindow','openDependency']);
 const png=app.calls.find(([name])=>name==='stageDependencyImage')[3];
 assert.equal(png.type,'image/png');
 assert.deepEqual(new Uint8Array(await png.arrayBuffer()),Uint8Array.of(1,2,3));
});

test('OCR 失败时只显示错误和恢复复制，释放交接句柄',async()=>{
 for(const options of [{dependency:'missing'},{rejectOpen:true}]){
  const app=fixture(options);
  await settle();
  assert.equal(app.element('actions').hidden,false);
  assert.equal(app.element('manage').hidden,options.dependency!=='missing');
  if(options.rejectOpen){
   assert.equal(app.element('status').textContent,'打开 OCR 失败');
   assert.ok(app.calls.some(([name,handle])=>name==='discardDependencyImage'&&handle==='staged'));
  }
  await app.element('copy').handlers.click();
  assert.ok(app.calls.some(([name,id,ticket])=>name==='execute'&&id==='copy'&&ticket==='ticket'));
  assert.equal(app.element('actions').hidden,true);
  assert.equal(app.calls.at(-1)[0],'hideWindow');
 }
});
