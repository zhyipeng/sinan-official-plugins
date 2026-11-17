import {drawPixels,drawPNG,thumbnailLoader} from './images.js';
import {pasteFailureMessage} from './platform.js';
import {ready,execute,pasteToPreviousApp} from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';
const $=id=>document.getElementById(id);
let clearPending=false;
let items=[],selected='',busy=false,loading=false,previewTicket=0,lastPreview='',queryTicket=0;
const thumbnails=thumbnailLoader(id=>command('thumbnail',id));
const thumbnailObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;thumbnailObserver.unobserve(entry.target);const canvas=entry.target;void thumbnails(canvas.dataset.id).then(data=>{if(canvas.isConnected)drawPixels(canvas,data);}).catch(()=>{if(canvas.isConnected)canvas.replaceWith(document.createTextNode('▧'));});}},{root:$('list'),rootMargin:'64px'});
const date=value=>new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
async function command(id,input=''){const result=await execute(id,input);const value=JSON.parse(result.text);if(value?.error)throw new Error(value.error);return value;}
function status(message){$('status').textContent=message;}
function controls(){for(const id of ['copy','paste','remove'])$(id).disabled=busy||!selected;$('clear').disabled=busy||!items.length;}
async function preview(){
 const item=items.find(row=>row.id===selected);controls();$('empty').hidden=!!item;$('image').hidden=true;$('text').textContent=item?.text??'';$('meta').textContent=item?`${item.kind==='image'?`${item.width} × ${item.height}`:'文本'}　${date(item.created)}`:'';
 const ticket=++previewTicket;
 if(!item)return;
 if(item.kind==='text'){const data=await command('preview',item.id);if(ticket!==previewTicket)return;$('text').textContent=data?.text??item.text;if(data?.truncated)$('meta').textContent+='　预览已截断';}
 if(item.kind==='image'){
  const data=await command('preview',item.id);if(ticket!==previewTicket||!data)return;
  await drawPNG($('image'),data,()=>ticket===previewTicket);
 }
}
function render(){
 const list=$('list');thumbnailObserver.disconnect();list.replaceChildren();
 for(const item of items){
  const row=document.createElement('button');row.type='button';row.className='row';row.id=`item-${item.id}`;row.setAttribute('role','option');row.setAttribute('aria-selected',String(item.id===selected));row.tabIndex=-1;
  const icon=document.createElement('span');icon.className='kind';icon.textContent=item.kind==='image'?'▧':'≡';icon.setAttribute('aria-hidden','true');
  if(item.kind==='image'){const canvas=document.createElement('canvas');canvas.className='thumbnail';canvas.dataset.id=item.id;icon.replaceChildren(canvas);thumbnailObserver.observe(canvas);}
  const content=document.createElement('span'),title=document.createElement('span'),time=document.createElement('span');title.className='title';title.textContent=item.kind==='image'?'图片':item.text.replace(/\s+/g,' ')||'空白文本';time.className='time';time.textContent=date(item.created);content.append(title,time);row.append(icon,content);
  row.addEventListener('click',()=>select(item.id));row.addEventListener('dblclick',()=>act('paste'));list.append(row);
 }
 list.setAttribute('aria-activedescendant',selected?`item-${selected}`:'');controls();
}
function select(id){const searching=document.activeElement===$('search');selected=id;render();if(!searching)$('list').focus({preventScroll:true});document.getElementById(`item-${id}`)?.scrollIntoView({block:'nearest'});lastPreview=id;void preview().catch(error=>status(error.message));}
async function refresh(){
 if(loading||busy)return;loading=true;const ticket=queryTicket;
 try{const data=await command('list',$('search').value);if(ticket!==queryTicket){setTimeout(()=>void refresh(),0);return;}const signature=JSON.stringify(data.items);if(signature!==JSON.stringify(items)){items=data.items;if(!items.some(item=>item.id===selected))selected=items[0]?.id??'';render();if(lastPreview!==selected){lastPreview=selected;await preview();}}status(data.status||`${items.length} 条`);controls();}catch(error){status(error.message);}finally{loading=false;}
}
async function act(action){
 if(busy||!selected)return;const id=selected;busy=true;controls();
 try{
  await command(action==='remove'?'delete':'select',id);
  if(action!=='remove'){queryTicket++;const index=items.findIndex(item=>item.id===id);if(index>0){items.unshift(...items.splice(index,1));render();}$('list').scrollTop=0;}
  if(action==='paste'){await pasteToPreviousApp();status('正在粘贴…');}
  else if(action==='copy')status('已复制');else{selected='';lastPreview='';}
 }catch(error){status(action==='paste'?pasteFailureMessage(error.message,navigator.platform):error.message);}finally{busy=false;controls();if(action==='remove')await refresh();}
}
$('search').addEventListener('input',()=>{queryTicket++;void refresh();});
for(const action of ['copy','paste','remove'])$(action).addEventListener('click',()=>void act(action));
$('clear').addEventListener('click',async()=>{if(busy)return;if(!clearPending){clearPending=true;$('clear').textContent='确认清空';setTimeout(()=>{clearPending=false;$('clear').textContent='清空';},4000);return;}clearPending=false;$('clear').textContent='清空';busy=true;controls();try{await command('clear');selected='';lastPreview='';}catch(error){status(error.message);}finally{busy=false;await refresh();}});
document.addEventListener('keydown',event=>{
 if(event.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;
 if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const current=items.findIndex(item=>item.id===selected),next=Math.max(0,Math.min(items.length-1,current+(event.key==='ArrowDown'?1:-1)));if(items[next])select(items[next].id);}
 if(event.key==='Enter'&&['search','list'].includes(document.activeElement?.id)){event.preventDefault();void act('paste');}
});
ready();void refresh();$('search').focus();setInterval(()=>{if(!document.hidden)void refresh();},2000);
