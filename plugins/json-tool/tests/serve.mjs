// Browser-only deterministic fixture. The real native bridge is covered by Go tests.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
const ui=new URL('../ui/',import.meta.url), sdk=new URL('../../../third_party/sinan/packages/plugin-sdk/ui/index.js',import.meta.url);
const mock=`window.webkit={messageHandlers:{sinan:{postMessage(){}},sinanCall:{async postMessage(req){
if(window.failSave&&req.method==='storage.put')throw Error('数据已变化，请重新载入后保存');
if(req.method==='storage.get')return structuredClone(window.doc??{revision:0,value:null});
if(req.method==='storage.put'){window.doc={revision:req.revision+1,value:req.value};return structuredClone(window.doc);}
try{return {text:JSON.stringify({output:JSON.stringify(JSON.parse(req.input),null,req.commandId==='format'?2:0)})};}catch{return {text:JSON.stringify({error:'JSON 格式错误',line:1,column:2})};}
}}}};`;
http.createServer(async(req,res)=>{
 try{
  const name=new URL(req.url,'http://127.0.0.1').pathname.slice(1)||'index.html';
  if(name==='mock.js'){res.setHeader('Content-Type','application/javascript');res.end(mock);return;}
  if(!['index.html','app.js','style.css','bridge.js'].includes(name)){res.writeHead(404).end();return;}
  let bytes=await readFile(name==='bridge.js'?sdk:new URL(name,ui));
  if(name==='index.html')bytes=bytes.toString().replace('<script type="module"','<script src="mock.js"></script><script type="module"');
  res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(bytes);
 }catch{res.writeHead(500).end();}
}).listen(9246,'127.0.0.1');
