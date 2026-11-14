import {ready,execute,readLaunch,listLLMConfigurations,startLLM,pollLLM,cancelLLM} from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';
const $=id=>document.getElementById(id);
let config,epoch=0,job='',jobKind='backend',composing=false;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function command(id,input=''){const data=JSON.parse((await execute(id,input)).text);if(data?.error)throw new Error(data.error);return data;}
function status(message,error=false){$('status').textContent=message;$('status').dataset.error=String(error);}
function label(code){if(code==='auto')return '自动识别';return config.languages.find(o=>o.value===code)?.label||({'zh':'中文'}[code])||code;}
function cancel(){epoch++;const previous=job;job='';if(previous)void (jobKind==='llm'?cancelLLM(previous):command('cancel',previous)).catch(()=>{});$('state').textContent='';}
function invalidate(){cancel();$('output').textContent='';$('copy').disabled=true;$('direction').textContent='译文';$('count').textContent=`${Array.from($('input').value).length} / 5000`;$('translate').disabled=!config||!$('input').value.trim();}
async function translate(){
 cancel();const ticket=epoch,text=$('input').value;
 if(!text.trim())return;
 status('正在翻译…');$('state').textContent='翻译中';
 try{
  const payload={text,source:$('source').value,target:$('target').value,engine:$('engine').value};
  let prompt;
  if(payload.engine==='llm')prompt=await command('prepare-llm',JSON.stringify(payload));
  if(ticket!==epoch)return;
  jobKind=payload.engine==='llm'?'llm':'backend';

  const started=jobKind==='llm'?await startLLM({profileId:$('llm-profile').value,systemPrompt:prompt.systemPrompt,input:prompt.input}):await command('translate',JSON.stringify(payload));
  if(ticket!==epoch){void (payload.engine==='llm'?cancelLLM(started.id):command('cancel',started.id)).catch(()=>{});return;}job=started.id;
  while(ticket===epoch){
   await pause($('engine').value==='llm'?1000:600);if(ticket!==epoch)return;
   const data=jobKind==='llm'?await pollLLM(started.id):await command('poll',started.id);if(ticket!==epoch)return;
   if(!data.done)continue;
   job='';void (jobKind==='llm'?cancelLLM(started.id):command('cancel',started.id)).catch(()=>{});
   if(data.error)throw new Error(data.error);
   const result=jobKind==='llm'?{text:data.text,source:prompt.source,target:prompt.target}:data.result;
   $('output').textContent=result.text;$('copy').disabled=!result.text;$('direction').textContent=`${label(result.source)} → ${label(result.target)}`;$('state').textContent='';status('翻译完成');return;
  }
 }catch(error){if(ticket===epoch){cancel();status(error.message,true);}}
}
$('input').addEventListener('compositionstart',()=>{composing=true;invalidate();});
$('input').addEventListener('compositionend',()=>{composing=false;invalidate();});
$('input').addEventListener('input',invalidate);
for(const id of ['source','target','engine','llm-profile'])$(id).addEventListener('change',()=>{
 invalidate();$('llm-controls').hidden=$('engine').value!=='llm';
 if($('input').value.trim())void translate();
});
$('translate').addEventListener('click',()=>void translate());
function hasSelection(){
 const active=document.activeElement;
 return (typeof active?.selectionStart==='number'&&active.selectionStart!==active.selectionEnd)||window.getSelection()?.isCollapsed===false;
}
function copyResult(){
 const text=$('output').textContent;
 if(!text)return;
 const active=document.activeElement,selection=window.getSelection();
 const ranges=selection?Array.from({length:selection.rangeCount},(_,i)=>selection.getRangeAt(i).cloneRange()):[];
 const start=active?.selectionStart,end=active?.selectionEnd,direction=active?.selectionDirection;
 const buffer=document.createElement('textarea');buffer.className='copy-buffer';buffer.value=text;buffer.readOnly=true;buffer.tabIndex=-1;buffer.setAttribute('aria-hidden','true');
 document.body.append(buffer);
 try{
  buffer.select();
  if(!document.execCommand('copy'))throw new Error('复制失败，请选中译文后重试');
  status('已复制译文');
 }catch{status('复制失败，请选中译文后重试',true);}
 finally{
  buffer.remove();active?.focus({preventScroll:true});
  if(typeof start==='number')active.setSelectionRange(start,end,direction);
  if(selection&&ranges.length){selection.removeAllRanges();for(const range of ranges)selection.addRange(range);}
 }
}
$('copy').addEventListener('click',copyResult);
document.addEventListener('keydown',event=>{
 if((event.metaKey||event.ctrlKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='c'&&!event.isComposing&&!composing&&!hasSelection()&&$('output').textContent){event.preventDefault();copyResult();return;}
 if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.isComposing&&!composing){event.preventDefault();void translate();}});
window.addEventListener('pagehide',cancel);
async function init(){
 ready();config=await command('config');
 for(const id of ['source','target'])for(const option of config.languages)$(id).add(new Option(option.label,option.value));
 for(const option of config.engines)$('engine').add(new Option(option.label,option.value));
 $('engine').value=config.engine;$('target').options[0].textContent=`常用：${label(config.target)}（自动）`;
 try{await loadProfiles();}catch{status('全局 LLM 配置读取失败，可继续使用免费引擎',true);}
 $('llm-controls').hidden=$('engine').value!=='llm';
 const launch=await readLaunch();if(typeof launch.input==='string')$('input').value=launch.input;
 invalidate();$('input').focus();if($('input').value.trim())await translate();
}
async function loadProfiles(){
 const settings=await listLLMConfigurations(),selected=$('llm-profile').value;
 $('llm-profile').replaceChildren(new Option('跟随默认配置',''));
 for(const profile of settings.profiles??[])$('llm-profile').add(new Option(profile.name,profile.id));
 if(settings.profiles?.some(p=>p.id===selected))$('llm-profile').value=selected;
 const current=settings.profiles?.find(p=>p.id===settings.defaultProfile);
 $('llm-profile').options[0].textContent=current?`跟随默认：${current.name}`:'请在设置中添加 LLM 配置';
}
$('llm-refresh').addEventListener('click',()=>void loadProfiles().catch(error=>status(error.message,true)));
void init().catch(error=>status(error.message,true));
