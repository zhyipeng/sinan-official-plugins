const bytes=value=>Uint8Array.from(atob(value),ch=>ch.charCodeAt(0));
export function drawPixels(canvas,data){
 canvas.width=data.width;canvas.height=data.height;
 canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes(data.pixels)),data.width,data.height),0,0);
}
export async function drawPNG(canvas,data,isCurrent){
 const bitmap=await createImageBitmap(new Blob([bytes(data.png)],{type:'image/png'}));
 try{if(!isCurrent())return;canvas.width=data.width;canvas.height=data.height;canvas.getContext('2d').drawImage(bitmap,0,0);canvas.hidden=false;}finally{bitmap.close();}
}
// Only visible rows request thumbnails. Limit concurrent RPCs and retained thumbnail data.
export function thumbnailLoader(load){
 const cache=new Map(),queue=[];let active=0;
 function drain(){while(active<2&&queue.length){const job=queue.shift();active++;Promise.resolve().then(()=>load(job.id)).then(job.resolve,error=>{cache.delete(job.id);job.reject(error);}).finally(()=>{active--;drain();});}}
 return id=>{
  if(cache.has(id))return cache.get(id);
  const promise=new Promise((resolve,reject)=>queue.push({id,resolve,reject}));cache.set(id,promise);
  if(cache.size>200)cache.delete(cache.keys().next().value);
  drain();return promise;
 };
}
