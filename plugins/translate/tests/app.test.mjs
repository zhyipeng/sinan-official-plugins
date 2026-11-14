import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const sourceFile=await readFile(new URL('../ui/app.js',import.meta.url),'utf8');
const withoutBridgeImport=text=>text.replace(/^import [^\r\n]*;\r?\n/,'');
const source=withoutBridgeImport(sourceFile);
const wait=async predicate=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('等待界面状态超时');};
function fixture(launch={},controls={}){
 const elements=new Map(),calls=[],listeners={},copied=[],llmCalls=[],cancelled=[];let next=0,buffer;
 const profiles=controls.profiles??[{id:'a'.repeat(32),name:'快速'},{id:'b'.repeat(32),name:'高质量'}];
 function node(id){if(!elements.has(id))elements.set(id,{value:({source:'auto',target:'smart'})[id]||'',textContent:'',options:id==='target'?[{}]:[],dataset:{},disabled:false,hidden:false,handlers:{},add(o){this.options.push(o);},replaceChildren(...items){this.options=items;this.value=items[0]?.value??'';},addEventListener(event,fn){this.handlers[event]=fn;},focus(){ctx.document.activeElement=this;}});return elements.get(id);}
 const ctx={document:{activeElement:null,body:{append(value){buffer=value;}},createElement(){return {value:'',setAttribute(){},select(){ctx.document.activeElement=this;},remove(){buffer=null;}};},execCommand(command){assert.equal(command,'copy');if(controls.copyFails)return false;copied.push(buffer.value);return true;},getElementById:node,addEventListener(e,fn){listeners[e]=fn;}},window:{addEventListener(){},getSelection(){return {isCollapsed:!controls.selected,rangeCount:0};}},Option:function(label,value){this.label=label;this.value=value;},setTimeout(fn){return setTimeout(fn,1);},ready(){},readLaunch:async()=>launch,
 listLLMConfigurations:async()=>({profiles,defaultProfile:profiles[0]?.id??''}),startLLM:async(value)=>{llmCalls.push(JSON.parse(JSON.stringify(value)));return {id:String(++next)};},pollLLM:async()=>controls.llmPoll?await controls.llmPoll():{done:true,text:'共享译文',error:''},cancelLLM:async(id)=>{cancelled.push(id);},execute:async(id,input)=>{
  calls.push({id,input});let value;
  if(id==='config')value={target:'zh-CN',engine:'google',languages:[{value:'zh-CN',label:'简体中文'},{value:'en',label:'英语'}],engines:[{value:'google',label:'Google'},{value:'mymemory',label:'MyMemory'},{value:'llm',label:'LLM'}]};
  if(id==='translate')value={id:String(++next)};
  if(id==='prepare-llm'){const r=JSON.parse(input);value={systemPrompt:'Translate into Chinese',input:r.text,source:'en',target:'zh-CN'};}
  if(id==='poll')value=controls.poll?await controls.poll(input):{done:true,result:{text:'你好',source:'en',target:'zh-CN'}};
  return {text:JSON.stringify(value??null)};
 }};
 vm.runInNewContext(source,ctx);return {node,calls,listeners,copied,llmCalls,cancelled};
}
test('主输入文本自动翻译，切换目标和引擎重新发送当前文本',async()=>{
 const f=fixture({input:'hello'});await wait(()=>f.node('output').textContent==='你好');
 const request=()=>JSON.parse(f.calls.filter(c=>c.id==='translate').at(-1).input);
 assert.deepEqual(request(),{text:'hello',source:'auto',target:'smart',engine:'google'});
 f.node('target').value='en';f.node('engine').value='mymemory';f.node('engine').handlers.change();
 await wait(()=>f.calls.filter(c=>c.id==='translate').length===2);assert.equal(request().target,'en');assert.equal(request().engine,'mymemory');
 await wait(()=>f.node('output').textContent==='你好');
});
test('普通打开不发送文本，编辑清除旧译文，输入法组合不触发快捷翻译',async()=>{
 const f=fixture();await wait(()=>f.node('engine').value==='google');assert.equal(f.calls.some(c=>c.id==='translate'),false);
 f.node('input').value='hello';f.node('input').handlers.input();
 f.node('input').handlers.compositionstart();f.listeners.keydown({key:'Enter',ctrlKey:true,preventDefault(){}});assert.equal(f.calls.some(c=>c.id==='translate'),false);
 f.node('input').handlers.compositionend();f.listeners.keydown({key:'Enter',ctrlKey:true,preventDefault(){}});
 await wait(()=>f.node('output').textContent==='你好');f.node('input').value='changed';f.node('input').handlers.input();assert.equal(f.node('output').textContent,'');
});

test('编辑后迟到的译文不会覆盖当前内容',async()=>{
 let resolveOld;
 const old=new Promise(resolve=>{resolveOld=resolve;});
 const f=fixture({input:'hello'},{poll:()=>old});
 await wait(()=>f.calls.some(c=>c.id==='poll'));
 f.node('input').value='new text';f.node('input').handlers.input();
 resolveOld({done:true,result:{text:'旧译文',source:'en',target:'zh-CN'}});
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(f.node('output').textContent,'');assert.equal(f.node('input').value,'new text');
 assert.ok(f.calls.some(c=>c.id==='cancel'));
});

test('复制按钮与 Cmd/Ctrl+C 复制完整译文并恢复输入焦点',async()=>{
 const f=fixture({input:'hello'});await wait(()=>f.node('output').textContent==='你好');
 assert.equal(f.node('copy').disabled,false);
 f.node('copy').handlers.click();assert.deepEqual(f.copied,['你好']);
 assert.equal(f.node('status').textContent,'已复制译文');
 for(const modifier of ['metaKey','ctrlKey']){
  let prevented=false;
  f.listeners.keydown({key:'c',[modifier]:true,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
 }
 assert.deepEqual(f.copied,['你好','你好','你好']);
 f.node('input').value='new';f.node('input').handlers.input();assert.equal(f.node('copy').disabled,true);
 let prevented=false;f.listeners.keydown({key:'c',ctrlKey:true,preventDefault(){prevented=true;}});assert.equal(prevented,false);assert.equal(f.copied.length,3);
});

test('选中原文或页面文本时保留系统复制，输入法组合不触发复制',async()=>{
 const controls={};const f=fixture({input:'hello'},controls);await wait(()=>f.node('output').textContent==='你好');
 const input=f.node('input');input.selectionStart=0;input.selectionEnd=2;input.focus();
 const copy=()=>f.listeners.keydown({key:'c',metaKey:true,preventDefault(){assert.fail('不应阻止正常复制');}});
 copy();input.selectionEnd=0;controls.selected=true;copy();controls.selected=false;
 input.handlers.compositionstart();copy();
 assert.deepEqual(f.copied,[]);
});

test('复制失败提示重试且恢复原文光标，不改写原文与译文',async()=>{
 const f=fixture({input:'hello'},{copyFails:true});await wait(()=>f.node('output').textContent==='你好');
 const input=f.node('input');input.selectionStart=2;input.selectionEnd=2;input.selectionDirection='none';let restored;
 input.setSelectionRange=(...args)=>{restored=args;};input.focus();
 f.node('copy').handlers.click();
 assert.deepEqual(restored,[2,2,'none']);assert.equal(input.value,'hello');assert.equal(f.node('output').textContent,'你好');
 assert.equal(f.node('status').dataset.error,'true');assert.equal(f.node('status').textContent,'复制失败，请选中译文后重试');assert.deepEqual(f.copied,[]);
});


test('翻译仅向 core 提交配置 ID、提示词与输入，各功能可选择不同全局配置',async()=>{
 const f=fixture({input:'hello'});await wait(()=>f.node('output').textContent==='你好');
 f.node('engine').value='llm';f.node('engine').handlers.change();await wait(()=>f.node('output').textContent==='共享译文');
 assert.deepEqual(f.llmCalls[0],{profileId:'',systemPrompt:'Translate into Chinese',input:'hello'});
 f.node('llm-profile').value='b'.repeat(32);f.node('llm-profile').handlers.change();await wait(()=>f.llmCalls.length===2);assert.equal(f.llmCalls[1].profileId,'b'.repeat(32));
 for(const request of f.llmCalls){for(const field of ['apiKey','baseURL','model'])assert.equal(field in request,false);}
 await wait(()=>f.node('output').textContent==='共享译文');
});
test('切换或编辑后取消 core LLM 任务，迟到结果不能覆盖新输入',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});const f=fixture({input:'hello'},{llmPoll:()=>pending});await wait(()=>f.node('output').textContent==='你好');
 f.node('engine').value='llm';f.node('engine').handlers.change();await wait(()=>f.llmCalls.length===1);await new Promise(r=>setTimeout(r,5));
 f.node('input').value='new';f.node('input').handlers.input();release({done:true,text:'旧结果',error:''});await new Promise(r=>setTimeout(r,10));assert.equal(f.node('output').textContent,'');assert.ok(f.cancelled.length>0);
});
test('没有全局配置时提示去设置，保持免费引擎可用',async()=>{
 const f=fixture({}, {profiles:[]});await wait(()=>f.node('llm-profile').options.length===1);assert.equal(f.node('llm-profile').options[0].textContent,'请在设置中添加 LLM 配置');assert.equal(f.node('engine').value,'google');assert.equal(f.calls.some(c=>c.id==='translate'),false);
});

test('界面夹具同时支持 LF 与 Windows CRLF 源文件',()=>{for(const newline of ["\n","\r\n"]){const text=sourceFile.replace(/\r?\n/g,newline);assert.doesNotThrow(()=>new vm.Script(withoutBridgeImport(text)));}});
