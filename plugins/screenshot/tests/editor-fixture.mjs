import {build} from 'esbuild';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {painterroPlugin} from '../../../scripts/painterro-csp.mjs';
const bundle=await build({entryPoints:['plugins/screenshot/ui/editor.js'],bundle:true,write:false,format:'cjs',plugins:[painterroPlugin()]});
export function editorFixture(){
 const {window,document}=parseHTML('<html><body><div id="editor"></div></body></html>'),calls=[],updates=[];
 const proto=window.HTMLElement.prototype;
 const classList=Object.getOwnPropertyDescriptor(window.Element.prototype,'classList');
 Object.defineProperty(window.Element.prototype,'classList',{configurable:true,get(){const list=classList.get.call(this);if(!Object.getOwnPropertyDescriptor(list,'0'))Object.defineProperty(list,'0',{get(){return Array.from(this)[0];}});return list;}});
 proto.scrollLeft=0;proto.scrollTop=0;
 proto.getBoundingClientRect=function(){
  const canvas=this.localName==='canvas',rect=this.className==='ptro-crp-rect';
  const left=Number.parseFloat(this.style.left)||0,top=Number.parseFloat(this.style.top)||0;
  let width=Number.parseFloat(this.style.width)||(canvas?Number(this.getAttribute('width')||1):800),height=Number.parseFloat(this.style.height)||(canvas?Number(this.getAttribute('height')||1):400);
  if(rect){width=this.parentElement.clientWidth-left-(Number.parseFloat(this.style.right)||0);height=this.parentElement.clientHeight-top-(Number.parseFloat(this.style.bottom)||0);}
  return {left,top,right:left+width,bottom:top+height,width,height};
 };
 for(const [name,key] of [['clientWidth','width'],['offsetWidth','width'],['clientHeight','height'],['offsetHeight','height']])Object.defineProperty(proto,name,{configurable:true,get(){return this.getBoundingClientRect()[key];}});
 proto.focus=function(){};
 const canvases=new WeakMap();
 window.HTMLCanvasElement.prototype.getContext=function(){if(!canvases.has(this)){
  const target={canvas:this,getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h}),createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h}),measureText:text=>({width:Array.from(text).length*12}),createLinearGradient:()=>({addColorStop(){}})};
  canvases.set(this,new Proxy(target,{get:(obj,key)=>key in obj?obj[key]:(...args)=>{calls.push([key,...args]);},set:(obj,key,value)=>{obj[key]=value;return true;}}));
 }return canvases.get(this);};
 window.HTMLCanvasElement.prototype.toBlob=function(fn){fn(new Blob([Uint8Array.from([1,2,3])],{type:'image/png'}));};
 window.HTMLCanvasElement.prototype.toDataURL=function(){throw new Error('CSP 禁止 data 图片回退');};
 for(const key of ['width','height'])Object.defineProperty(window.HTMLCanvasElement.prototype,key,{configurable:true,get(){return Number(this.getAttribute(key)||0);},set(v){this.setAttribute(key,String(v));}});
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.getAttribute('value')||this.querySelector('option')?.getAttribute('value')||'';},set(value){for(const option of this.querySelectorAll('option')){if(option.getAttribute('value')===value)option.setAttribute('selected','');else option.removeAttribute('selected');}}});
 window.getComputedStyle=node=>node.style;window.getSelection=()=>({removeAllRanges(){}});
 const module={exports:{}};
 const context={window,document,Element:window.Element,HTMLElement:window.HTMLElement,CustomEvent:window.CustomEvent,MutationObserver:window.MutationObserver,Blob,Uint8Array,Uint8ClampedArray,ArrayBuffer,Math,Number,Object,console,setTimeout,clearTimeout,module,exports:module.exports};
 vm.runInNewContext(bundle.outputFiles[0].text,context);
 const holder=document.getElementById('editor'),editor=module.exports.createEditor(holder,(...args)=>updates.push(args));
 function mouse(type,x,y,target=holder.querySelector('.ptro-crp-el')){const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{clientX:x,clientY:y,button:0});target.dispatchEvent(e);}
 return {window,document,holder,editor,calls,updates,mouse,click(name){holder.querySelector(`button[aria-label="${name}"]`).click();},bitmap:(width=160,height=80)=>({width,height})};
}
