import test from 'node:test';
import assert from 'node:assert/strict';
import {editorFixture} from './editor-fixture.mjs';
import {historyLimit,wrapText,applyTemplateStyles} from '../ui/painterro-runtime.js';
import {encodeChunk,decodeChunk} from '../ui/transfer.js';
import {adaptPainterro,verifyPainterro,writePainterroAssets,readPainterroIcons} from '../../../scripts/painterro-csp.mjs';
import {readFile,mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('实际 Painterro 加载原图、绘制箭头与矩形、撤销重做并以 PNG 导出',async()=>{
 const f=editorFixture();f.editor.load(f.bitmap());assert.ok(f.holder.querySelector('.ptro-icon-arrow svg path'));assert.deepEqual(f.updates.at(-1),[160,80]);
 f.mouse('mousedown',10,10);f.mouse('mousemove',60,40);f.mouse('mouseup',60,40);assert.ok(f.calls.some(c=>c[0]==='lineTo'));
 f.click('rect');f.mouse('mousedown',20,20);f.mouse('mousemove',80,55);f.mouse('mouseup',80,55);assert.ok(f.calls.some(c=>c[0]==='strokeRect'));
 const before=f.calls.filter(c=>c[0]==='putImageData').length;f.editor.undo();f.editor.redo();assert.ok(f.calls.filter(c=>c[0]==='putImageData').length>=before+2);
 const blob=await f.editor.exportPNG();assert.equal(blob.type,'image/png');assert.equal(blob.size,3);f.editor.destroy();assert.equal(f.holder.children.length,0);
});
test('实际文字工具用 Canvas 绘制中文与换行，不解释 HTML 或加载 data 图片',()=>{
 const f=editorFixture();f.editor.load(f.bitmap());f.click('text');f.mouse('mousedown',10,10);
 const input=f.holder.querySelector('[contenteditable]');input.textContent='中文\n<img src=x>';
 f.holder.querySelector('.ptro-text-tool-apply').click();assert.ok(f.calls.some(c=>c[0]==='fillText'&&c[1].includes('中文')));assert.equal(f.holder.querySelectorAll('img[src="x"]').length,0);assert.equal(f.holder.querySelectorAll('style').length,0);f.editor.destroy();
});
test('新截图重置历史、忙碌时停止交互、尺寸与历史缓存有界',()=>{
 const f=editorFixture();f.editor.load(f.bitmap());f.editor.load(f.bitmap(120,60));assert.deepEqual(f.updates.at(-1),[120,60]);f.editor.undo();assert.deepEqual(f.updates.at(-1),[120,60]);
 f.editor.setBusy(true);assert.equal(f.holder.inert,true);f.editor.setBusy(false);assert.equal(f.holder.inert,false);assert.throws(()=>f.editor.load(f.bitmap(10000,10000)),/3200/);f.editor.destroy();
 assert.equal(historyLimit(8000,4000),1);assert.equal(historyLimit(160,80),20);
});
test('文字折行与分块编码保持字符和字节',()=>{
 assert.deepEqual(wrapText({measureText:s=>({width:Array.from(s).length*10})},'中文😀测试\nA',20),['中文','😀测','试','A']);
 const data=Uint8Array.from({length:36*1024},(_,i)=>i%256);assert.deepEqual(decodeChunk(encodeChunk(data)),data);
});
test('来源摘要、SVG 图标和静态样式不依赖字体或内联 style',async()=>{
 await verifyPainterro();const temporary=await mkdtemp(join(tmpdir(),'sinan-painterro-'));
 try{const ui=join(temporary,'ui');await writePainterroAssets(ui);assert.equal(Object.keys(await readPainterroIcons()).length,36);const css=await readFile(join(ui,'painterro.css'),'utf8');assert.ok(!/@font-face|data:|https?:|url\(/.test(css));assert.deepEqual((await readdir(ui)).sort(),['painterro.css']);assert.match(await readFile(join(temporary,'THIRD_PARTY_NOTICES.txt'),'utf8'),/MIT/);
 for(const file of await readdir('node_modules/painterro/js')){const original=await readFile(`node_modules/painterro/js/${file}`,'utf8'),patched=adaptPainterro(`js/${file}`,original);assert.ok(!/(?<![\w-])style=["']/.test(patched),file);assert.ok(!/dom-to-image|navigator\.clipboard|createElement\(['"]style['"]\)/.test(patched),file);}
 }finally{await rm(temporary,{recursive:true,force:true});}
});
test('实际选择工具裁剪与像素化保留后续导出能力',async()=>{
 const f=editorFixture();f.editor.load(f.bitmap());f.click('select');f.mouse('mousedown',10,10);f.mouse('mousemove',90,60);f.mouse('mouseup',90,60);f.click('crop');
 const [width,height]=f.updates.at(-1);assert.ok(width>0&&width<160&&height>0&&height<80);
 f.click('select');f.mouse('mousedown',2,2);f.mouse('mousemove',30,30);f.mouse('mouseup',30,30);f.click('pixelize');assert.ok(f.calls.some(c=>c[0]==='putImageData'));assert.equal((await f.editor.exportPNG()).type,'image/png');f.editor.destroy();
});

test('私有构建补丁在上游源码变化时明确失败',async()=>{
 const main=await readFile('node_modules/painterro/js/main.js','utf8');assert.throws(()=>adaptPainterro('js/main.js',main.replace("    const style = this.doc.createElement('style');",'')),/补丁位置/);
});
test('实际文字输入在组合结束后限制长度并保留完整 Unicode 字符',()=>{
 const f=editorFixture();f.editor.load(f.bitmap());f.click('text');f.mouse('mousedown',10,10);const input=f.holder.querySelector('[contenteditable]');input.textContent='😀'.repeat(2001);
 const composing=new f.window.Event('input');Object.assign(composing,{isComposing:true});input.dispatchEvent(composing);assert.equal(Array.from(input.textContent).length,2001);
 input.dispatchEvent(new f.window.Event('compositionend'));assert.equal(Array.from(input.textContent).length,2000);f.editor.destroy();
});
