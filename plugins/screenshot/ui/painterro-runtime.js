// No image URLs, foreignObject rendering, font downloads or native clipboard.
export function historyLimit(width,height){return Math.min(20,Math.max(1,Math.floor((64*1024*1024)/(width*height*4))-1));}
export function wrapText(ctx,text,maxWidth){
 const lines=[];
 for(const paragraph of text.replace(/\r\n?/g,'\n').split('\n')){
  let line='';for(const character of Array.from(paragraph)){if(line&&ctx.measureText(line+character).width>maxWidth){lines.push(line);line='';}line+=character;}lines.push(line);
 }
 return lines.slice(0,100);
}
export function commitText(tool){
 if(!tool.active)return;
 const text=Array.from(tool.input.innerText||tool.input.textContent||'').slice(0,2000).join('');
 if(!text.trim()){tool.close();return;}
 const ctx=tool.ctx;
 const [x,y]=tool.scaledCord,scale=tool.main.getScale();
 const size=Math.max(1,Math.min(256,Number(tool.fontSize)||24))*scale;
 ctx.save();ctx.font=`${tool.isItalic?'italic ':''}${tool.isBold?'bold ':''}${size}px ${tool.font}`;
 ctx.fillStyle=tool.input.style.color||tool.main.colorWidgetState.line.alphaColor;ctx.textBaseline='top';
 if(tool.strokeOn){ctx.strokeStyle=tool.strokeColor;ctx.lineWidth=Math.max(1,size/14);ctx.lineJoin='round';}
 const width=Math.max(1,Math.min(tool.main.canvas.width-x,(tool.input.clientWidth||200)*scale));
 const lines=wrapText(ctx,text,width);
 lines.forEach((line,index)=>{const top=y+index*size*1.25;if(tool.strokeOn)ctx.strokeText(line,x,top);ctx.fillText(line,x,top);});
 ctx.restore();tool.close();tool.main.worklog.captureState();tool.main.closeActiveTool();
}
export function applyTemplateStyles(root,icons={}){
 const nodes=[...(root.matches?.('[data-ptro-style]')?[root]:[]),...root.querySelectorAll('[data-ptro-style]')];
 for(const node of nodes){const style=node.getAttribute('data-ptro-style');node.removeAttribute('data-ptro-style');for(const declaration of style.split(';')){const colon=declaration.indexOf(':');if(colon<0)continue;const name=declaration.slice(0,colon).trim(),value=declaration.slice(colon+1).trim();if(/^[a-z-]+$/.test(name)&&!/[{}]|url\s*\(|expression\s*\(/i.test(value))node.style.setProperty(name,value);}}
 for(const node of root.querySelectorAll('.ptro-icon')){
  const name=Array.from(node.classList).find(value=>value.startsWith('ptro-icon-'))?.slice(10),icon=icons[name];
  if(!icon||node.getAttribute('data-ptro-icon')===name)continue;
  const doc=root.ownerDocument,svg=doc.createElementNS('http://www.w3.org/2000/svg','svg'),path=doc.createElementNS('http://www.w3.org/2000/svg','path');
  svg.setAttribute('viewBox',`0 0 ${icon.width} 612`);svg.setAttribute('aria-hidden','true');path.setAttribute('transform','translate(0 612) scale(1 -1)');path.setAttribute('d',icon.d);svg.appendChild(path);node.setAttribute('data-ptro-icon',name);node.replaceChildren(svg);
 }

}
export function observeTemplates(root,icons){
 applyTemplateStyles(root,icons);
 const observer=new MutationObserver(()=>applyTemplateStyles(root,icons));observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
 return ()=>observer.disconnect();
}
export function insertPlainText(event){
 const target=event.target.closest('[contenteditable]');if(!target)return;
 event.preventDefault();event.stopPropagation();
 const text=(event.clipboardData?.getData('text/plain')||'').slice(0,Math.max(0,2000-(target.innerText||'').length));
 const selection=target.ownerDocument.defaultView.getSelection();if(!selection?.rangeCount)return;
 const range=selection.getRangeAt(0);if(!target.contains(range.commonAncestorContainer))return;
 range.deleteContents();const node=target.ownerDocument.createTextNode(text);range.insertNode(node);range.setStartAfter(node);range.collapse(true);selection.removeAllRanges();selection.addRange(range);target.dispatchEvent(new target.ownerDocument.defaultView.Event('input',{bubbles:true}));
}
