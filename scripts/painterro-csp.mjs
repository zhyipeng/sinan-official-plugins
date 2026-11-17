import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,relative,sep} from 'node:path';
import {parse} from 'acorn';
const root=fileURLToPath(new URL('../',import.meta.url));
const vendor=join(root,'node_modules/painterro');
const meta=JSON.parse(await readFile(join(root,'plugins/screenshot/painterro-upstream.json'),'utf8'));
export async function verifyPainterro(){
 for(const [name,hash] of Object.entries(meta.files)){if(createHash('sha256').update(await readFile(join(vendor,name))).digest('hex')!==hash)throw new Error(`Painterro 来源校验失败：${name}`);}
 if(JSON.parse(await readFile(join(vendor,'package.json'),'utf8')).version!==meta.version)throw new Error('Painterro 版本不匹配');
}
function once(text,before,after){if(text.split(before).length!==2)throw new Error(`Painterro 补丁位置已变化：${before.slice(0,60)}`);return text.replace(before,after);}
export function replaceMethod(text,name,replacement){
 const ast=parse(text,{sourceType:'module',ecmaVersion:'latest'}),matches=[];
 function visit(node){if(!node||typeof node!=='object')return;if(node.type==='MethodDefinition'&&node.key.name===name)matches.push(node);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}}
 visit(ast);if(matches.length!==1)throw new Error(`Painterro 方法位置已变化：${name}`);const node=matches[0];return text.slice(0,node.start)+replacement+text.slice(node.end);
}
const disabledInserter=`export default class Inserter {constructor(){this.waitChoice=false;} static get(){return new Inserter();} init(){} html(){return '<div class="ptro-paster-select-wrapper" hidden></div>';} cancelChoosing(){this.waitChoice=false;} handleKeyDown(){return false;} handleOpen(){throw new Error('请使用区域截图载入图片');}}`;
const disabledResizer=`export default class Resizer {constructor(){} static html(){return '<div class="ptro-resize-widget-wrapper" hidden></div>';}}`;
export function adaptPainterro(name,original){
 let text=original;
 if(name==='js/inserter.js')return disabledInserter;
 if(name==='js/resizer.js')return disabledResizer;
 if(name==='js/main.js'){
  text=once(text,"import isMobile from 'ismobilejs';","const isMobile={any:false};");
  text=text.replace(/^import .*\.css';\r?\n/gm,'');
  text=once(text,"import { set } from 'lodash';",'');
  text=once(text,"    const style = this.doc.createElement('style');\n    style.type = 'text/css';\n    style.innerHTML = this.params.styles;\n    this.baseEl.appendChild(style);",'');
  text=replaceMethod(text,'handleClipCopyEvent','handleClipCopyEvent(){return false;}');
  text=replaceMethod(text,'loadImage',`loadImage(){throw new Error('图片只能由截图会话载入');}`);
  text=once(text,'this.resize(img.naturalWidth, img.naturalHeight);\n    this.ctx.drawImage(img, 0, 0);','this.resize(img.naturalWidth || img.width,img.naturalHeight || img.height);\n    this.ctx.drawImage(img, 0, 0);');
  text=once(text,'zoomImage({ wheelDelta, clientX, clientY }','zoomImage({ wheelDelta, deltaY, clientX, clientY }');
  text=once(text,'let whD = wheelDelta;','let whD = Number.isFinite(wheelDelta) ? wheelDelta : -Number(deltaY || 0);');
  text=once(text,'  resize(x, y) {',`  resize(x,y){if(!Number.isInteger(x)||!Number.isInteger(y)||x<1||y<1||x*y>32000000)throw new Error('图片尺寸无效或超过 3200 万像素');`);
  const start=text.indexOf('      keydown: (e) => {'),end=text.indexOf('      paste: (event) => {',start);
  if(start<0||end<0)throw new Error('Painterro 键盘补丁位置已变化');
  text=text.slice(0,start)+`      keydown:(e)=>{
       if(!this.shown||e.defaultPrevented||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.target.closest('input,textarea,select,[contenteditable]'))return;
       if(this.colorPicker.handleKeyDown(e)||this.handleToolEvent('handleKeyDown',e))return;
       const tool=this.toolByKeyCode[e.keyCode];if(tool){this.getBtnEl(tool).click();e.preventDefault();}
      },\n`+text.slice(end);
 }
 if(name==='js/text.js'){
  text=once(text,"import domtoimage from 'dom-to-image';",`import {commitText} from ${JSON.stringify(join(root,'plugins/screenshot/ui/painterro-runtime.js'))};`);
  text=replaceMethod(text,'apply','apply(){return commitText(this);}');
  text=once(text,'this.pendingClear = true;','this.pendingClear = false;');
  text=once(text,'      this.input.onkeydown = (e) => {','      this.input.onkeydown = (e) => { if(e.isComposing||e.keyCode===229)return;');
  text=once(text,'if (e.ctrlKey && e.keyCode === KEYS.enter)','if ((e.ctrlKey || e.metaKey) && e.keyCode === KEYS.enter)');
 }
 if(name==='js/params.js'){
  const start=text.indexOf('  params.styles ='),end=text.indexOf('\n  return params;',start);if(start<0||end<0)throw new Error('Painterro 样式补丁位置已变化');text=text.slice(0,start)+"  params.styles='';\n"+text.slice(end);
  // Preference storage stays in memory inside this disposable editor.
  text=text.replace('localStorage.getItem(STORAGE_KEY)','null').replace('localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));','');
 }
 if(name==='js/filters.js')text=once(text,"import { filter } from 'lodash';",'');
 if(name==='js/translation.js'){
  text=text.replace(/^import (?!en from).+;\r?\n/gm,'');text=text.replace(/this\.translations = \{[\s\S]*?\};/, 'this.translations = {en};');
 }
 // Inline style attributes become owned CSSOM properties after each DOM update.
 text=text.replace(/\bstyle=(?=["'])/g,'data-ptro-style=');
 return text;
}
export async function readPainterroIcons(){
 const font=await readFile(join(vendor,'css/icons/ptroiconfont.svg'),'utf8'),icons={};
 for(const match of font.matchAll(/<glyph\b([^>]+)\/?\s*>/g)){
  const attributes=Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
  const name=attributes['glyph-name'],d=attributes.d;if(!name||!d||name.endsWith('-1'))continue;
  if(!/^[a-z0-9_]+$/.test(name))throw new Error('Painterro 图标名称无效');
  const width=Number(attributes['horiz-adv-x']||886.3448275862069);if(!Number.isFinite(width))throw new Error('Painterro 图标尺寸无效');
  icons[name]={width,d};
 }
 if(Object.keys(icons).length!==36)throw new Error('Painterro 图标数量变化');return icons;
}
export function painterroPlugin(){return {name:'painterro-isolated',setup(build){
 build.onResolve({filter:/^sinan:painterro-icons$/},()=>({path:'icons',namespace:'painterro'}));
 build.onLoad({filter:/.*/,namespace:'painterro'},async()=>({contents:'export default '+JSON.stringify(await readPainterroIcons()),loader:'js'}));
 build.onLoad({filter:/[\\/]node_modules[\\/]painterro[\\/]js[\\/].*\.js$/},async({path})=>({contents:adaptPainterro(relative(vendor,path).split(sep).join('/'),await readFile(path,'utf8')),loader:'js',resolveDir:join(path,'..')}));
}};}
export async function writePainterroAssets(directory){
 await verifyPainterro();await mkdir(directory,{recursive:true});
 let css=(await readFile(join(vendor,'css/styles.css'),'utf8'))+'\n'+await readFile(join(vendor,'css/bar-styles.css'),'utf8');
 css=css.replace(/i\.mce-i-painterro:before,[\s\S]*?\}/,'').replaceAll('url("checkers.svg")','repeating-conic-gradient(#d8dde6 0% 25%,#f3f5f9 0% 50%)');
 css+='\n.ptro-substrate,.ptro-crp-rect,.ptro-color-widget-wrapper{background-size:12px 12px}\n';
 css+='\n.ptro-icon{display:inline-flex;width:16px;height:16px}.ptro-icon svg{width:100%;height:100%;fill:currentColor;pointer-events:none}.ptro-icon:before{content:none!important}\n';
 await writeFile(join(directory,'painterro.css'),css);
 await writeFile(join(directory,'..','THIRD_PARTY_NOTICES.txt'),await readFile(join(vendor,'LICENSE')));
}

export async function checkScreenshotBudget(directory){
 let count=0,total=0;
 async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){count++;const file=join(path,entry.name);if(entry.isSymbolicLink())throw new Error('截图资源不能包含符号链接');if(entry.isDirectory()){await walk(file);continue;}if(!/\.(html|js|css|png|jpg|jpeg|webp)$/.test(entry.name))throw new Error('截图 UI 资源类型不受宿主支持');const size=(await stat(file)).size;if(size>512*1024)throw new Error('截图单个资源超过 512 KiB');total+=size;}}
 await walk(directory);if(count>128||total>2*1024*1024)throw new Error('截图资源总预算超限');return {count,bytes:total};
}
