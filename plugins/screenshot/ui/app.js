import {ready,execute,executeHidden,readLaunch,showWindow,hideWindow,savePNG,openImage,readClipboardImage,readDependencies,stageDependencyImage,openDependency,discardDependencyImage,openDependencyManager} from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';
import {decodeChunk,encodeChunk} from './transfer.js';
import {createEditor} from './editor.js';
const $=id=>document.getElementById(id);
let editor=null,hasImage=false,busy=false,disposed=false,epoch=0,job='';
function status(text,error=false){$('status').textContent=text;$('status').dataset.error=String(error);}
function refresh(){
 $('start').disabled=$('import').disabled=busy;$('ocr').disabled=busy||!hasImage;$('manage-dependency').disabled=busy;$('copy').disabled=$('save').disabled=busy||!hasImage;
 editor?.setBusy(busy);
}
async function command(id,input=''){const result=JSON.parse((await execute(id,input)).text);if(result.error)throw new Error(result.error);return result;}
async function cancel(){epoch++;const id=job;job='';busy=false;refresh();status('已取消');if(id)await command('cancel',id).catch(()=>{});}
async function start(){
 if(busy||disposed)return;const ticket=++epoch;busy=true;refresh();status('拖动选择区域，Esc 取消');
 try{
  const result=JSON.parse((await executeHidden('capture-region','ocr')).text);
  if(ticket!==epoch||disposed){if(result.id)void command('cancel',result.id).catch(()=>{});return;}
  if(result.error || result.state!=='done')throw new Error(result.error||'截图已取消');
  if(result.action==='completed')return;
  job=result.id;refresh();
  if(!Number.isSafeInteger(result.size)||result.size<1||result.size>8*1024*1024)throw new Error('截图大小超限');
  const chunks=[];let size=0;status('正在读取截图…');
  while(size<result.size){const chunk=decodeChunk((await command('read',`${job}:${size}`)).data);if(!chunk.length||size+chunk.length>result.size)throw new Error('截图分块无效');chunks.push(chunk);size+=chunk.length;if(ticket!==epoch||disposed)return;}
  const image=new Blob(chunks,{type:'image/png'});
  let ocrError='';
  if(result.action==='ocr'){
   try{
    await requireOCR();
    await openOCR(image,ticket,true);
    return;
   }catch(error){ocrError=error.message||'无法打开 OCR';}
  }
  if(ticket!==epoch||disposed)return;
  const bitmap=await createImageBitmap(image);
  if(ticket!==epoch||disposed){bitmap.close();return;}
  $('editor').hidden=false;
  try{if(!editor)editor=createEditor($('editor'),(width,height)=>{$('dimensions').textContent=`${width} × ${height}`;});editor.load(bitmap);hasImage=true;}finally{bitmap.close();}
  $('empty').hidden=true;await showWindow();status(ocrError||'截图完成',Boolean(ocrError));

 }catch(error){if(ticket===epoch&&!disposed){status(error.message||'截图失败',true);await hideWindow().catch(()=>{});}}
 finally{if(ticket===epoch){const id=job;job='';busy=false;refresh();if(id)void command('cancel',id).catch(()=>{});}}
}
async function loadExternal(source){
 if(busy||disposed)return;const ticket=++epoch;busy=true;refresh();status(source==='file'?'请选择图片…':'正在读取剪贴板图片…');
 try{
  const image=source==='file'?await openImage():await readClipboardImage();
  if(ticket!==epoch||disposed)return;
  if(!image){status(source==='file'?'已取消导入':'剪贴板中没有图片');return;}
  const decoded=new Image();decoded.src=image.url;await decoded.decode();
  if(ticket!==epoch||disposed)return;
  const bitmap=await createImageBitmap(decoded);
  try{
   if(ticket!==epoch||disposed)return;
   $('editor').hidden=false;
   if(!editor)editor=createEditor($('editor'),(width,height)=>{$('dimensions').textContent=`${width} × ${height}`;});
   editor.load(bitmap);hasImage=true;$('empty').hidden=true;status(source==='file'?'图片已导入':'图片已粘贴');
  }finally{bitmap.close();}
 }catch(error){if(ticket===epoch&&!disposed)status(error.message||'无法读取图片',true);}
 finally{if(ticket===epoch&&!disposed){busy=false;refresh();}}
}
async function output(kind){
 if(busy||!hasImage)return;busy=true;refresh();status(kind==='copy'?'正在复制…':'正在保存…');
 try{
  const blob=await editor.exportPNG();if(!blob||blob.size>8*1024*1024)throw new Error('导出图片超过 8 MiB，请缩小选区');
  const data=new Uint8Array(await blob.arrayBuffer()),upload=await command('upload-start');
  for(let offset=0;offset<data.length;offset+=36*1024){if(disposed)return;await command('upload',`${upload.id}:${offset}:${encodeChunk(data.subarray(offset,offset+36*1024))}`);}
  if(disposed)return;if(kind==='copy'){await command('copy',upload.id);status('已复制并关闭');await hideWindow();}else{const result=await savePNG('save',upload.id);status(result.saved?'已保存 PNG':'已取消保存');}
 }catch(error){status(error.message||'导出失败',true);}finally{busy=false;refresh();}
}
async function requireOCR(){
 const ocr=(await readDependencies()).find(dep=>dep.id==='ocr');
 $('manage-dependency').hidden=ocr?.state==='available';
 if(ocr?.state!=='available')throw new Error(ocr?.message||'OCR 插件不可用');
}
async function openOCR(blob,ticket,fromOverlay=false){
 let handle='';
 try{
  if(ticket!==epoch||disposed)return;
  status('正在打开 OCR…');handle=await stageDependencyImage('ocr','recognize-image',blob);
  if(ticket!==epoch||disposed)return;
  if(fromOverlay){
   // The host swaps the embedded view but does not reveal its hidden window.
   $('editor').hidden=true;$('empty').hidden=true;
   await showWindow();
  }
  if(ticket!==epoch||disposed)return;
  await openDependency('ocr','recognize-image',{imageHandle:handle});handle='';
 }finally{if(handle)await discardDependencyImage(handle).catch(()=>{});}
}
async function recognize(){
 if(busy||!hasImage||disposed)return;const ticket=epoch;busy=true;refresh();status('正在检查 OCR…');
 try{
  await requireOCR();
  await openOCR(await editor.exportPNG(),ticket);
 }catch(error){if(!disposed&&ticket===epoch)status(error.message||'无法打开 OCR',true);}
 finally{if(!disposed){busy=false;refresh();}}
}
$('ocr').addEventListener('click',()=>void recognize());
$('manage-dependency').addEventListener('click',()=>{void openDependencyManager().catch(error=>status(error.message||'无法打开插件中心',true));});
$('copy').addEventListener('click',()=>void output('copy'));$('save').addEventListener('click',()=>void output('save'));
$('start').addEventListener('click',()=>void start());
$('import').addEventListener('click',()=>void loadExternal('file'));
document.addEventListener('keydown',event=>{
 if(event.isComposing||event.altKey||event.target.closest('input,select,textarea,[contenteditable]')||!(event.metaKey||event.ctrlKey))return;
 const key=event.key.toLowerCase();
 if(key==='z'&&editor&&!busy){event.preventDefault();event.stopImmediatePropagation();event.shiftKey?editor.redo():editor.undo();}
 if(key==='c'&&!String(window.getSelection())){event.preventDefault();event.stopImmediatePropagation();void output('copy');}
 if(key==='v'){event.preventDefault();event.stopImmediatePropagation();void loadExternal('clipboard');}
 if(key==='s'){event.preventDefault();event.stopImmediatePropagation();void output('save');}
},true);
document.addEventListener('paste',event=>{
 if(event.target.closest('input,select,textarea,[contenteditable]'))return;
 event.preventDefault();event.stopImmediatePropagation();void loadExternal('clipboard');
},true);
window.addEventListener('pagehide',()=>{disposed=true;void cancel();editor?.destroy();editor=null;hasImage=false;});
refresh();ready();

const launchEpoch=epoch;
readLaunch().then(launch=>{if(!disposed&&epoch===launchEpoch&&launch.commandId==='capture')void start();}).catch(error=>status(error.message||'无法读取启动参数',true));
