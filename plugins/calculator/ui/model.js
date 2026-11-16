export const MAX_PAPERS=50,MAX_ROWS=100,MAX_BYTES=32*1024;
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
export function paper(now=Date.now(),id=crypto.randomUUID()){return {id,created:now,updated:now,rows:['']};}
export function initial(){const p=paper();return {version:1,active:p.id,papers:[p]};}
export function validate(value){
 if(value===null)return initial();
 if(value?.version!==1||!Array.isArray(value.papers)||!value.papers.length||value.papers.length>MAX_PAPERS)throw new Error('稿纸格式不正确，已停止保存');
 const ids=new Set();for(const p of value.papers){if(typeof p.id!=='string'||!p.id||ids.has(p.id)||!Number.isFinite(p.created)||!Number.isFinite(p.updated)||!Array.isArray(p.rows)||!p.rows.length||p.rows.length>MAX_ROWS||p.rows.some(r=>typeof r!=='string'||new TextEncoder().encode(r).length>512))throw new Error('稿纸格式不正确，已停止保存');ids.add(p.id);}
 if(!ids.has(value.active)||bytes(value)>MAX_BYTES)throw new Error('稿纸格式或容量不正确，已停止保存');return structuredClone(value);
}
export function fits(value){return bytes(value)<=MAX_BYTES;}
// CAS writes are serialized and coalesced. A conflict blocks further writes;
// the current editor stays intact rather than replacing another window's data.
export class DraftStore {
 constructor(write,onState){this.write=write;this.onState=onState;this.revision=0;this.generation=0;this.saved=0;this.blocked=false;this.busy=false;}
 load(doc){this.value=validate(doc.value);this.revision=doc.revision;this.generation=this.saved=0;this.blocked=false;return this.value;}
 change(value){this.value=structuredClone(value);this.generation++;this.onState(this.blocked?'保存失败，当前输入已保留。请备份后重新打开。':'未保存');}
 async save(){if(this.busy||this.blocked||this.saved===this.generation)return;this.busy=true;try{while(this.saved!==this.generation&&!this.blocked){const generation=this.generation,value=structuredClone(this.value);if(!fits(value))throw new Error('容量已满，请删除部分稿纸');this.onState('保存中…');const doc=await this.write(this.revision,value);this.revision=doc.revision;this.saved=generation;}this.onState('已保存');}catch{this.blocked=true;this.onState('保存失败，当前输入已保留。请备份后重新打开。');}finally{this.busy=false;}}
}
