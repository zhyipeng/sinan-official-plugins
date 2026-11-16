import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
function run(command,args,cwd=root){const child=spawnSync(command,args,{cwd,stdio:'inherit'});if(child.error)throw child.error;if(child.status!==0)process.exit(child.status||1);}
// Enumerate paths ourselves: Windows cmd.exe does not expand shell globs.
const files=dir=>readdirSync(join(root,dir)).filter(name=>name.endsWith('.test.mjs')).map(name=>join(root,dir,name));
run(process.execPath,['--test',...files('plugins/json-tool/tests'),...files('plugins/clipboard/tests'),...files('plugins/translate/tests'),...files('plugins/calendar/tests'),...files('plugins/calculator/tests'),...files('plugins/ocr/tests'),...files('scripts/tests')]);
run(process.platform==='win32'?'python':'python3',['-m','unittest','discover','-s','scripts/tests','-p','test_*.py']);
run('go',['test','-race','./backend'],join(root,'plugins/clipboard'));
run('go',['test','-race','./backend'],join(root,'plugins/translate'));
run('go',['test','-race','./backend'],join(root,'plugins/calculator'));
run('go',['test','-race','./backend','./internal/...'],join(root,'plugins/ocr'));
