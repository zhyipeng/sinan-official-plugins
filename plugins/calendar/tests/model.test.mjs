import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dayInfo,monthHighlights,dateKey,supportedDate,clampMonth,holidayYears} from '../ui/model.js';
const day=text=>{const [y,m,d]=text.split('-').map(Number);return new Date(y,m-1,d);};
test('春节农历、除夕与放假/补班分别识别',()=>{
 const spring=dayInfo(day('2026-02-17'));
 assert.equal(spring.lunar.lunarMon,1);assert.equal(spring.lunar.lunarDay,1);assert.ok(spring.festivals.includes('春节'));assert.equal(spring.rest,true);assert.equal(spring.work,false);
 const eve=dayInfo(day('2026-02-16'));assert.ok(eve.festivals.includes('除夕'));
 const work=dayInfo(day('2026-02-14'));assert.equal(work.work,true);assert.equal(work.rest,false);assert.equal(work.holidayName,'春节');
 const ordinary=dayInfo(day('2026-11-15'));assert.equal(ordinary.rest,false);assert.equal(ordinary.work,false);
});
test('已核对的 2027 假期及补班',()=>{
 assert.ok(holidayYears.includes(2027));
 assert.equal(dayInfo(day('2027-02-05')).rest,true);
 assert.equal(dayInfo(day('2027-02-14')).work,true);
 assert.equal(dayInfo(day('2027-09-15')).rest,true);
});
test('节气、闰月与未知年份降级',()=>{
 assert.ok(dayInfo(day('2026-04-05')).terms.includes('清明'));
 const leap=dayInfo(day('2025-07-25'));assert.equal(leap.lunar.isLeap,true);assert.match(leap.lunarText,/闰六月/);
 const unknown=dayInfo(day('2028-10-01'));assert.equal(unknown.holidayKnown,false);assert.equal(unknown.rest,false);assert.equal(unknown.work,false);assert.ok(unknown.festivals.includes('国庆节'));
 assert.equal(dayInfo(day('2000-01-01')).holidayKnown,false);
});
test('月份列表只包含本月，支持边界不越界',()=>{
 const items=monthHighlights(day('2026-02-01'));assert.ok(items.some(item=>item.key==='2026-02-17'));assert.ok(items.every(item=>item.key.startsWith('2026-02-')));
 for(const key of ['1901-01-01','2099-12-31'])assert.ok(dayInfo(day(key)).lunarText);
 assert.equal(dayInfo(day('1900-12-31')),null);assert.equal(supportedDate(new Date(NaN)),false);
 assert.equal(dateKey(clampMonth(day('2100-01-01'))),'2099-01-01');
});
test('本地民用日期在东西半球及夏令时下保持一致',()=>{
 const url=new URL('../ui/model.js',import.meta.url).href;
 for(const tz of ['Asia/Shanghai','America/New_York','Pacific/Honolulu','Pacific/Auckland']){
  const script=`import {dayInfo,dateKey} from ${JSON.stringify(url)};const d=new Date(2026,5,19);console.log(JSON.stringify({key:dateKey(d),lunar:dayInfo(d).lunarText,festival:dayInfo(d).festivals}));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:tz},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{key:'2026-06-19',lunar:'丙午年 五月初五',festival:['端午节']});
 }
});
