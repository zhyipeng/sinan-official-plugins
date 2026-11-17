import test from 'node:test';
import assert from 'node:assert/strict';
import {thumbnailLoader,drawPNG} from '../ui/images.js';

test('缩略图复用请求并限制并发，失败后允许重试',async()=>{
 const pending=[];let active=0,peak=0,calls=0;
 const load=thumbnailLoader(id=>new Promise((resolve,reject)=>{calls++;active++;peak=Math.max(peak,active);pending.push({id,resolve:value=>{active--;resolve(value);},reject:error=>{active--;reject(error);}});}));
 const first=load('a');assert.equal(load('a'),first);
 const second=load('b'),third=load('c');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,2);assert.equal(peak,2);
 pending.shift().resolve('image-a');assert.equal(await first,'image-a');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,3);
 const failed=assert.rejects(second,/fixture/);pending.shift().reject(new Error('fixture'));await failed;
 pending.shift().resolve('image-c');assert.equal(await third,'image-c');
 const retry=load('b');await new Promise(resolve=>setImmediate(resolve));pending.shift().resolve('image-b');assert.equal(await retry,'image-b');
 assert.equal(await load('a'),'image-a');assert.equal(calls,4);
});

test('切换选中项后不绘制过时图片，并释放解码资源',async()=>{
 const original=globalThis.createImageBitmap;let finish,closed=0,drawn=0;
 globalThis.createImageBitmap=()=>new Promise(resolve=>{finish=()=>resolve({close(){closed++;}});});
 const canvas={hidden:true,getContext:()=>({drawImage(){drawn++;}})};
 const data={width:80,height:60,png:btoa('fixture')};
 try{
  const stale=drawPNG(canvas,data,()=>false);finish();await stale;
  assert.equal(closed,1);assert.equal(drawn,0);assert.equal(canvas.hidden,true);
  const current=drawPNG(canvas,data,()=>true);finish();await current;
  assert.equal(closed,2);assert.equal(drawn,1);assert.equal(canvas.hidden,false);assert.equal(canvas.width,80);assert.equal(canvas.height,60);
 }finally{globalThis.createImageBitmap=original;}
});
