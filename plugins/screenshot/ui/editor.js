import Painterro from 'painterro/js/main.js';
import icons from 'sinan:painterro-icons';
import {historyLimit,observeTemplates,insertPlainText,applyTemplateStyles} from './painterro-runtime.js';
const translation={name:'zh-CN',strings:{
 lineColor:'颜色',lineColorFull:'线条颜色',fillColor:'填充',fillColorFull:'填充颜色',alpha:'透明',alphaFull:'透明度',lineWidth:'粗细',lineWidthFull:'线条粗细',arrowLength:'箭头',arrowLengthFull:'箭头大小',textColor:'颜色',textColorFull:'文字颜色',fontSize:'字号',fontSizeFull:'文字大小',fontName:'字体',fontNameFull:'字体',fontIsBold:'粗体',fontIsBoldFull:'粗体',fontIsItalic:'斜体',fontIsItalicFull:'斜体',shadowOn:'阴影',shadowOnFull:'图形阴影',fontStrokeAndShadow:'描边',fontStrokeAndShadowFull:'文字描边',apply:'确定',cancel:'取消',close:'关闭',pixelSize:'像素',pixelSizeFull:'像素块大小',backgroundColor:'背景颜色',clear:'清空',tools:{select:'选择区域',crop:'裁剪选区',pixelize:'选区像素化',arrow:'箭头',rect:'矩形',ellipse:'椭圆',text:'文字',brush:'画笔',undo:'撤销',redo:'重做',zoomin:'放大',zoomout:'缩小'}}};
export function createEditor(container,onChange){
 const painter=Painterro({id:container.id,defaultSize:'1x1',toolbarPosition:'top',toolbarHeightPx:44,buttonSizePx:30,defaultTool:'arrow',defaultLineWidth:4,defaultPrimitiveShadowOn:false,defaultTextStrokeAndShadow:false,defaultFontSize:24,activeColor:'#e5484d',hiddenTools:['line','eraser','rotate','resize','save','open','close','settings','clear','bucket','filters'],translation,onChange:()=>onChange(painter.canvas.width,painter.canvas.height)});
 // The private editor never opens files, navigates URLs or accesses a native clipboard.
 for(const name of ['paste','drop','dragover','dragleave'])delete painter.documentHandlers[name];
 const disconnect=observeTemplates(container,icons);
 const input=painter.textTool.input;
 const textChanged=event=>{if(event.isComposing)return;const value=Array.from(input.innerText||input.textContent||'');if(value.length>2000)input.textContent=value.slice(0,2000).join('');painter.textTool.reLimit();};
 input.addEventListener('input',textChanged);input.addEventListener('compositionend',textChanged);
 container.addEventListener('paste',insertPlainText,true);
 const drop=event=>event.preventDefault();container.addEventListener('drop',drop,true);
 function flush(){if(painter.textTool.active)painter.textTool.apply();painter.closeActiveTool();}
 return {
  load(bitmap){
   if(!Number.isInteger(bitmap.width)||!Number.isInteger(bitmap.height)||bitmap.width<1||bitmap.height<1||bitmap.width*bitmap.height>32000000)throw new Error('图片超过 3200 万像素');
   painter.closeActiveTool(true);painter.worklog.current=null;painter.worklog.first=null;
   painter.params.worklogLimit=historyLimit(bitmap.width,bitmap.height);
   painter.show(false);painter.fitImage(bitmap,'image/png');painter.setActiveTool(painter.defaultTool);
   applyTemplateStyles(container,icons);
  },
  undo(){if(painter.worklog.current)painter.worklog.undoState();},
  redo(){if(painter.worklog.current)painter.worklog.redoState();},
  setBusy(value){container.inert=value;if(value)painter.removeEventHandlers();else if(painter.shown)painter.attachEventHandlers();},
  async exportPNG(){flush();return new Promise((resolve,reject)=>painter.canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法导出图片')),'image/png'));},
  destroy(){painter.hide();disconnect();input.removeEventListener('input',textChanged);input.removeEventListener('compositionend',textChanged);container.removeEventListener('paste',insertPlainText,true);container.removeEventListener('drop',drop,true);container.replaceChildren();},
 };
}
