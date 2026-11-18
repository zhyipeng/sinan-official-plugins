import {spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
function run(command,args,cwd=root){const child=spawnSync(command,args,{cwd,stdio:'inherit'});if(child.error)throw child.error;if(child.status!==0)process.exit(child.status||1);}
// Enumerate paths ourselves: Windows cmd.exe does not expand shell globs.
const files=dir=>readdirSync(join(root,dir)).filter(name=>name.endsWith('.test.mjs')).map(name=>join(root,dir,name));
run(process.execPath,['--test',...files('plugins/json-tool/tests'),...files('plugins/clipboard/tests'),...files('plugins/translate/tests'),...files('plugins/calendar/tests'),...files('plugins/calculator/tests'),...files('plugins/ocr/tests'),...files('scripts/tests'),...files('plugins/screenshot/tests')]);
run(process.platform==='win32'?'python':'python3',['-m','unittest','discover','-s','scripts/tests','-p','test_*.py']);
run('go',['test','-race','./backend'],join(root,'plugins/clipboard'));
run('go',['test','-race','./backend'],join(root,'plugins/translate'));
run('go',['test','-race','./backend'],join(root,'plugins/calculator'));
run('go',['test','-race','./backend','./internal/...'],join(root,'plugins/ocr'));

run('go',['test','-race','./backend'],join(root,'plugins/screenshot'));
run('go',['test','-race','./backend'],join(root,'plugins/script'));


if(process.platform==='darwin'){
 const native=join(root,'plugins/screenshot/native');
 const dir=mkdtempSync(join(tmpdir(),'sinan-annotation-tests-'));
 const executable=join(dir,'annotations');
 try{
  run('xcrun',['--sdk','macosx','clang','-fobjc-arc','-Wall','-Wextra','-Werror',
   '-framework','AppKit','-framework','ApplicationServices','-framework','CoreText','-framework','ImageIO','-framework','UniformTypeIdentifiers',
   join(native,'tests','annotations.m'),join(native,'overlay-annotations.m'),join(native,'snap-targets.m'),'-o',executable]);
  run(executable,[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
}
