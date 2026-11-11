import {ready,execute,readData,writeData} from './bridge.js';
const editor=document.querySelector('#editor'),status=document.querySelector('#status'),error=document.querySelector('#error'),reload=document.querySelector('#reload');
const format=document.querySelector('#format'),compact=document.querySelector('#compact'),clear=document.querySelector('#clear');
let revision=0, generation=0, saved=0, timer, saving=false, blocked=false, running=false;
function failure(message){error.textContent=message;error.hidden=!message;}
function controls(){format.disabled=compact.disabled=running||editor.disabled;clear.disabled=editor.disabled||running;}
function size(){document.querySelector('#size').textContent=`${new TextEncoder().encode(editor.value).length.toLocaleString()} 字节`;}
async function save(){
 if(saving||blocked||saved===generation)return;
 saving=true;const version=generation,text=editor.value;status.textContent='正在保存…';
 try{const next=await writeData(revision,{text});revision=next.revision;saved=version;status.textContent=saved===generation?'草稿已保存':'草稿未保存';}
 catch(reason){blocked=true;reload.hidden=false;status.textContent='草稿未保存';failure(reason instanceof Error?reason.message:String(reason));}
 finally{saving=false;if(!blocked&&saved!==generation)void save();}
}
function changed(){generation++;size();failure('');status.textContent='草稿未保存';clearTimeout(timer);timer=setTimeout(save,700);}
async function load(){
 clearTimeout(timer);editor.disabled=true;controls();failure('');status.textContent='正在读取草稿…';
 try{const doc=await readData();revision=doc.revision;editor.value=typeof doc.value?.text==='string'?doc.value.text:'';generation=saved=0;blocked=false;reload.hidden=true;status.textContent=revision?'草稿已保存':'输入 JSON';editor.disabled=false;size();}
 catch(reason){editor.disabled=false;blocked=true;status.textContent='草稿读取失败';failure(reason instanceof Error?reason.message:String(reason));reload.hidden=false;}
 controls();
}
async function run(command){
 if(running||editor.disabled)return;
 // A pending save shares the private channel. Defer formatting until it settles.
 if(saving){status.textContent='正在保存，请稍后重试';return;}
 clearTimeout(timer);running=true;controls();failure('');
 const text=editor.value;
 try{
  const response=await execute(command,text);const result=JSON.parse(response.text);
  if(editor.value!==text)return;
  if(result.error){failure(result.line?`${result.error}：第 ${result.line} 行，第 ${result.column} 列`:result.error);return;}
  editor.value=result.output;changed();
 }catch(reason){failure(reason instanceof Error?reason.message:String(reason));}
 finally{running=false;controls();if(saved!==generation&&!blocked)timer=setTimeout(save,700);}
}
editor.addEventListener('input',changed);format.addEventListener('click',()=>void run('format'));compact.addEventListener('click',()=>void run('compact'));
clear.addEventListener('click',()=>{editor.value='';changed();editor.focus();});
reload.addEventListener('click',()=>{if(!saving)void load();});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();void run(event.shiftKey?'compact':'format');}});
ready();void load();
