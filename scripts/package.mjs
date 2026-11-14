import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const child=spawnSync(process.platform==='win32'?'python':'python3',['scripts/package.py'],{cwd:root,stdio:'inherit'});
if(child.error)throw child.error;process.exitCode=child.status??1;
