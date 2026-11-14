// UI bridge v2. No plugin identity, path or general host binding is accepted.
export function ready() { window.webkit.messageHandlers.sinan.postMessage({kind:'ready',version:2}); }
let tail=Promise.resolve(), pending=0;
function call(request) {
  const bridge=window.webkit?.messageHandlers?.sinanCall;
  if(!bridge) return Promise.reject(new Error('请在司南插件窗口中打开。'));
  if(pending>=8)return Promise.reject(new Error('调用过于频繁，请稍后重试。'));
  pending++;
  const result=tail.then(()=>bridge.postMessage(request));
  tail=result.catch(()=>{}).finally(()=>{pending--;});
  return result;
}
export function execute(commandId,input) { return call({method:'command.execute',commandId,input}); }
export function readData() { return call({method:'storage.get'}); }
export function writeData(revision,value) { return call({method:'storage.put',revision,value}); }

// Only the current view's explicit opening input; never the live search field.
export function readLaunch() { return call({method:'launch.get'}); }

// Restores the host-captured target and pastes the current system clipboard.
export function pasteToPreviousApp() { return call({method:'input.paste'}); }

// Session-bound encrypted private data; plaintext is exposed only to its owner view.
export function readEncryptedData() { return call({method:"storage.encrypted.get"}); }
export function writeEncryptedData(revision,value) { return call({method:"storage.encrypted.put",revision,value}); }

export function listLLMConfigurations() { return call({method:"llm.config"}); }
export function startLLM(value) { return call({method:"llm.start",value}); }
export function pollLLM(input) { return call({method:"llm.poll",input}); }
export function cancelLLM(input) { return call({method:"llm.cancel",input}); }
