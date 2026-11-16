// Deliberately mirrors the native provider's bounded grammar. Shared fixtures
// check both implementations; no dynamic code execution or remote dependency.
const limit=1n<<2048n;
function error(message){throw new Error(message);}
function rat(n,d=1n){if(!d)error('不能除以零');if(d<0n){n=-n;d=-d;}let a=n<0n?-n:n,b=d;while(b){[a,b]=[b,a%b];}n/=a;d/=a;if(n<=-limit||n>=limit||d>=limit)error('计算超出范围');return {n,d};}
function number(text){const match=/^([+-]?)(\d*\.?\d+|\d+\.?)(?:e([+-]?\d+))?$/.exec(text);if(!match)error('数字格式不正确');const exponent=Number(match[3]||0);if(Math.abs(exponent)>300)error('科学计数法指数超出范围');const [whole,fraction='']=match[2].split('.'),power=exponent-fraction.length;const digits=BigInt((whole||'0')+fraction)*(match[1]==='-'?-1n:1n);return power>=0?rat(digits*10n**BigInt(power)):rat(digits,10n**BigInt(-power));}
const add=(a,b)=>rat(a.n*b.d+b.n*a.d,a.d*b.d),neg=a=>rat(-a.n,a.d),mul=(a,b)=>rat(a.n*b.n,a.d*b.d),div=(a,b)=>rat(a.n*b.d,a.d*b.n),cmp=(a,b)=>a.n*b.d-b.n*a.d;
function floating(n){if(!Number.isFinite(n))error('结果不在实数范围内或超出范围');return number(Number(n.toPrecision(15)).toString());}
const float=a=>{const n=a.n<0n?-a.n:a.n,ns=Math.max(0,n.toString(2).length-54),ds=Math.max(0,a.d.toString(2).length-54);return (a.n<0n?-1:1)*Number(n>>BigInt(ns))/Number(a.d>>BigInt(ds))*2**(ns-ds);};
function format(a){if(a.n===0n)return '0';if(a.d===1n)return String(a.n);let d=a.d,two=0,five=0;while(d%2n===0n){d/=2n;two++;}while(d%5n===0n){d/=5n;five++;}if(d===1n&&Math.max(two,five)<=100){const places=Math.max(two,five),scaled=(a.n<0n?-a.n:a.n)*10n**BigInt(places)/a.d,s=String(scaled).padStart(places+1,'0');return (a.n<0n?'-':'')+(s.slice(0,-places)+'.'+s.slice(-places)).replace(/0+$/,'').replace(/\.$/,'');}let n=a.n<0n?-a.n:a.n;d=a.d;let exp=n.toString().length-d.toString().length;
 if(exp>=0?n<d*10n**BigInt(exp):n*10n**BigInt(-exp)<d)exp--;
 const scale=14-exp;if(scale>=0)n*=10n**BigInt(scale);else d*=10n**BigInt(-scale);
 let q=n/d;const rem=n%d;if(rem*2n>d||(rem*2n===d&&q%2n===1n))q++;
 if(q>=10n**15n){q/=10n;exp++;}let digits=q.toString().padStart(15,'0');
 let result;if(exp< -4||exp>=15){digits=digits.replace(/0+$/,'');result=digits[0]+(digits.length>1?'.'+digits.slice(1):'')+'e'+(exp<0?'-':'+')+String(Math.abs(exp)).padStart(2,'0');}
 else {const place=exp+1;result=place>0?digits.slice(0,place)+(place<digits.length?'.'+digits.slice(place):''):'0.'+'0'.repeat(-place)+digits;result=result.replace(/0+$/,'').replace(/\.$/,'');}
 return (a.n<0n?'-':'')+result;}
function fn(name,args){if(name==='min'||name==='max')return args.reduce((v,a)=>name==='min'?cmp(a,v)<0n?a:v:cmp(a,v)>0n?a:v);if(args.length!==1)error('函数需要一个参数');const a=args[0],v=float(a);if(name==='abs')return rat(a.n<0n?-a.n:a.n,a.d);if(['round','floor','ceil'].includes(name)){let q=a.n/a.d,r=a.n%a.d;if(name==='floor'&&r<0n)q--;if(name==='ceil'&&r>0n)q++;if(name==='round'&&(r<0n?-r:r)*2n>=a.d)q+=a.n<0n?-1n:1n;return rat(q);}const funcs={sqrt:Math.sqrt,sin:Math.sin,cos:Math.cos,tan:Math.tan,ln:Math.log,log:Math.log10,round:n=>n<0?-Math.round(-n):Math.round(n),floor:Math.floor,ceil:Math.ceil};if(!Object.hasOwn(funcs,name))error('不支持的函数');return floating(funcs[name](v));}
export function evaluate(source){try{
 if(new TextEncoder().encode(source).length>512)error('表达式最多 512 字节');
 const chars={'×':'*','ｘ':'*','÷':'/','−':'-','－':'-','＋':'+','（':'(','）':')','％':'%'};
 const text=source.toLowerCase().replaceAll('π','pi').replace(/[×ｘ÷−－＋（）％]/g,c=>chars[c]).replace(/\s/g,' ').trim().replace(/=$/,'').trim();if(!text)return {};
 let pos=0,depth=0;const skip=()=>{while(text[pos]===' ')pos++;};const eat=c=>{skip();if(text[pos]===c){pos++;return true;}return false;};
 function guard(run){if(++depth>64)error('运算嵌套过深');try{return run();}finally{depth--;}}
 function expression(){return guard(()=>{let v=product();for(;;){if(eat('+'))v=add(v,product());else if(eat('-'))v=add(v,neg(product()));else return v;}});}
 function product(){let v=unary();for(;;){if(eat('*'))v=mul(v,unary());else if(eat('/'))v=div(v,unary());else return v;}}
 function unary(){return guard(()=>eat('+')?unary():eat('-')?neg(unary()):power());}
 function power(){let v=atom();while(eat('%'))v=div(v,rat(100n));if(eat('^')){const e=unary();if(e.d===1n){if(e.n>1000n||e.n< -1000n)error('指数超出范围');let n=e.n;if(n<0n){v=div(rat(1n),v);n=-n;}if(BigInt(v.n.toString(2).length)*n>4096n||BigInt(v.d.toString(2).length)*n>4096n)error('计算超出范围');v=rat(v.n**n,v.d**n);}else v=floating(Math.pow(float(v),float(e)));}return v;}
 function atom(){skip();if(eat('(')){const v=expression();if(!eat(')'))error('缺少右括号');return v;}const name=/^[a-z]+/.exec(text.slice(pos))?.[0];if(name){pos+=name.length;if(name==='pi')return floating(Math.PI);if(name==='e')return floating(Math.E);if(!eat('('))error('不支持的名称或缺少左括号');const args=[expression()];while(eat(',')){if(args.length>=16)error('函数参数过多');args.push(expression());}if(!eat(')'))error('缺少右括号');return fn(name,args);}const value=/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/.exec(text.slice(pos))?.[0];if(!value)error('请输入完整的计算表达式');pos+=value.length;return number(value);}
 const result=expression();skip();if(pos!==text.length)error('含有不支持的字符或缺少运算符');return {result:format(result)};
 }catch(reason){return {error:reason.message};}}
