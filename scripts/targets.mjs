export const targets = ['darwin-arm64','darwin-amd64','windows-arm64','windows-amd64','linux-arm64','linux-amd64'];
export function hostTarget(){return `${{win32:'windows'}[process.platform]||process.platform}-${{x64:'amd64'}[process.arch]||process.arch}`;}
export function selectedTargets(args){
 if(!args.length){const target=hostTarget();if(!targets.includes(target))throw new Error("不支持当前构建平台");return [target];}
 if(args.length===1&&args[0]==='--all')return targets;
 const selected=args.map(arg=>arg.startsWith('--target=')?arg.slice(9):'');
 if(selected.some(target=>!targets.includes(target))||new Set(selected).size!==selected.length)throw new Error('请使用 --all 或 --target=<darwin|windows|linux>-<arm64|amd64>');
 return selected;
}
