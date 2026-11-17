"""模拟 Host API 验证本机截图包的 stdio 分块与复制，不捕获真实屏幕或访问剪贴板。先运行 build-screenshot.mjs。"""
import base64,json,struct,zlib,random,subprocess,hashlib,platform
from pathlib import Path
root=Path(__file__).resolve().parents[1]
system={'Darwin':'darwin','Windows':'windows','Linux':'linux'}[platform.system()]
arch={'aarch64':'arm64','arm64':'arm64','amd64':'amd64','x86_64':'amd64'}[platform.machine().lower()]
entry=root/'bin/targets'/f'{system}-{arch}'/'screenshot/backend'/('plugin.exe' if system=='windows' else 'plugin')
def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
rng=random.Random(75);raw=b''.join(b'\0'+rng.randbytes(512*4) for _ in range(512))
data=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',512,512,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
proc=subprocess.Popen([str(entry)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
next_id=0;writes=0

def send(value):proc.stdin.write(json.dumps(value,separators=(',',':'))+'\n');proc.stdin.flush()
def rpc(method,params):
 global next_id,writes
 next_id+=1;request_id=next_id;send({'jsonrpc':'2.0','id':request_id,'method':method,'params':params})
 while True:
  line=proc.stdout.readline();assert line,'plugin exited unexpectedly';value=json.loads(line)
  if 'method' in value:
   assert value['method']=='clipboard.write'
   content=value['params']['content'];assert content['kind']=='image';assert base64.b64decode(content['data'])==data
   writes+=1
   send({'jsonrpc':'2.0','id':value['id'],**({'error':{'code':-32000,'message':'synthetic rejection'}} if writes==1 else {'result':{}})})
   continue
  assert value['id']==request_id and 'error' not in value,value
  return value['result']
def command(name,value=''):return json.loads(rpc('command.execute',{'commandId':name,'input':value})['text'])
try:
 rpc('initialize',{'apiVersion':'1','pluginId':'tools.screenshot','hostCapabilities':['clipboard.v1','ui.window-execute.v1','ui.image-output.v1','ui.image-input.v1']})
 identifier=command('upload-start')['id']
 for offset in range(0,len(data),36*1024):
  part=data[offset:offset+36*1024];result=command('upload',identifier+':'+str(offset)+':'+base64.b64encode(part).decode());assert result['size']==offset+len(part)
 exported=bytearray()
 while len(exported)<len(data):
  part=command('save',identifier+':'+str(len(exported)));assert part['size']==len(data) and 'path' not in part
  exported.extend(base64.b64decode(part['data']))
 assert bytes(exported)==data
 failed=command('copy',identifier);assert failed.get('error')
 assert command('copy',identifier)['state']=='done'
 assert command('copy',identifier).get('error'),'upload ID can be replayed'
 assert writes==2
 proc.stdin.close();assert proc.wait(timeout=5)==0
 print(json.dumps({'syntheticPNGBytes':len(data),'chunks':(len(data)+36*1024-1)//(36*1024),'sha256':hashlib.sha256(data).hexdigest(),'clipboardFailureThenRetry':'passed','uploadReplayRejected':True,'hostPNGExportChunks':'passed','stdioShutdown':'passed','realScreenOrClipboardAccessed':False},indent=2))
finally:
 if proc.poll() is None:proc.kill();proc.wait()
