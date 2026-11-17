import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {hostTarget} from './targets.mjs';
const target=hostTarget();
if(process.env.OCR_TARGET&&process.env.OCR_TARGET!==target)throw new Error('Runner 的真实 OS/架构与矩阵目标不一致');
const inputs=JSON.parse(await readFile('bin/ocr-inputs/inputs.json','utf8'));
function run(program,args){
 const result=spawnSync(program,args,{stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);
}
run(process.execPath,['scripts/build-ocr.mjs','--target='+target,'--source='+inputs.source,'--models='+inputs.models,...(inputs.toolchain?['--toolchain='+inputs.toolchain]:[])]);
const python=process.platform==='win32'?'python':'python3';
run(python,['scripts/package-ocr.py','--target='+target,'--out=dist/ocr/'+target]);
run(python,['plugins/ocr/tests/relocated-smoke.py','--artifacts=dist/ocr/'+target]);
