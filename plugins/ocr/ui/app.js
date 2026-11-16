import {ready,execute,writeClipboardText,readLaunch,readClipboardImage,executeImage} from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';
const $=id=>document.getElementById(id),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let epoch=0,job='',busy=false,disposed=false,pasteReading=false;
function preview(image){$('preview').src=image.url;$('original').hidden=false;}
async function command(id,input=''){return JSON.parse((await execute(id,input)).text);}
function status(text,error=false){$('status').textContent=text;$('status').dataset.error=String(error);}
function refresh(){const text=$('output').value;$('start').disabled=busy;$('cancel').hidden=!busy;$('output').disabled=busy;$('copy').disabled=busy||!text.trim();$('count').textContent=text?`${Array.from(text).length} 字`:'';}
async function cancel(){epoch++;busy=false;const previous=job;job='';refresh();status('已取消');if(previous)await command('cancel',previous).catch(()=>{});}
async function start(image){
 if(busy||disposed)return;const ticket=++epoch;busy=true;refresh();status('正在识别…');
 try{
  if(!image)image=await readClipboardImage();
  if(!image)throw new Error('请先截图或复制一张图片');
  if(ticket!==epoch||disposed)return;
  preview(image);$('output').value='';refresh();
  const started=JSON.parse((await executeImage('start',image.url)).text);
  if(ticket!==epoch||disposed){if(started.id)void command('cancel',started.id).catch(()=>{});return;}
  if(started.error||!started.id)throw new Error(started.error||'无法创建识别任务');job=started.id;
  while(ticket===epoch&&!disposed){
   await pause(1000);if(ticket!==epoch||disposed)return;
   const result=await command('poll',started.id);if(ticket!==epoch||disposed)return;
   if(result.state==='running')continue;
   job='';busy=false;
   if(result.error)throw new Error(result.error);
   if(result.state==='cancelled'){status('已取消');refresh();return;}
   if(result.state!=='done')throw new Error('识别任务未完成，请重试');
   $('output').value=result.text||'';refresh();status(result.text?'识别完成':'未识别到文字');
   void command('cancel',started.id).catch(()=>{});return;
  }
 }catch(error){if(ticket===epoch&&!disposed){const previous=job;job='';busy=false;refresh();status(error.message||'识别失败，请重试',true);if(previous)void command('cancel',previous).catch(()=>{});}}
}
$('start').addEventListener('click',()=>void start());
$('cancel').addEventListener('click',()=>void cancel());
$('output').addEventListener('input',refresh);
async function copy(){if(busy||!$('output').value.trim())return;try{await writeClipboardText($('output').value);status('已复制');}catch{status('复制失败，请选中文字后重试',true);}}
$('copy').addEventListener('click',copy);
async function pasteImage(){
 if(busy||disposed||pasteReading)return;
 pasteReading=true;const ticket=++epoch;
 try{const image=await readClipboardImage();if(image&&ticket===epoch&&!disposed&&document.visibilityState!=='hidden')void start(image);}
 catch(error){if(ticket===epoch&&!disposed)status(error.message||'无法读取剪贴板图片',true);}
 finally{pasteReading=false;}
}
// Keep native text paste; snapshot images directly even when a WebView omits file items.
document.addEventListener('keydown',event=>{
 if(event.isComposing||event.repeat||event.altKey||event.shiftKey||!(event.metaKey||event.ctrlKey))return;
 const key=event.key.toLowerCase();
 if(key==='v'){void pasteImage();return;}
 if(key==='c'){
  const output=$('output'),selected=(document.activeElement===output&&output.selectionStart!==output.selectionEnd)||String(window.getSelection?.()||'');
  if(!selected&&!busy&&output.value.trim()){event.preventDefault();void copy();}
 }
});
document.addEventListener('paste',event=>{
 if(event.defaultPrevented||busy||disposed)return;
 const items=Array.from(event.clipboardData?.items||[]);
 if(!items.some(item=>item.kind==='file'&&item.type.startsWith('image/')))return;
 event.preventDefault();void pasteImage();
});
window.addEventListener('pagehide',()=>{disposed=true;void cancel();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&busy)void cancel();});
refresh();ready();
const launchTicket=epoch;
readLaunch().then(launch=>{if(launch.image&&!disposed&&document.visibilityState!=='hidden'&&epoch===launchTicket)void start(launch.image);}).catch(()=>{if(!disposed&&epoch===launchTicket)status('无法读取图片会话，请升级宿主后重试',true);});
