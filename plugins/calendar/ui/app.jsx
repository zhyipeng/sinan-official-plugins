import React, {useEffect, useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DayPicker, DayButton} from '@daypicker/react';
import {zhCN} from '@daypicker/react/locale';
import '@daypicker/react/style.css';
import './style.css';
import {ready} from '../../../third_party/sinan/packages/plugin-sdk/ui/index.js';
import {MIN_YEAR, MAX_YEAR, holidayYears, dateKey, supportedDate, clampMonth, dayInfo, monthHighlights} from './model.js';

export function CalendarDay(props) {
  const info=dayInfo(props.day.date);
  if (!info) return <DayButton {...props}>{props.day.date.getDate()}</DayButton>;
  const fullLabel = `${props['aria-label'] || info.key}，农历${info.lunarText}${info.festivals.length ? `，${info.festivals.join('、')}` : ''}${info.terms.length ? `，${info.terms.join('、')}` : ''}${info.rest ? '，放假' : info.work ? '，调休补班' : ''}`;
  return <DayButton {...props} aria-label={fullLabel} title={fullLabel}>
    <span className="solar-number">{props.day.date.getDate()}</span>
    <span className={`lunar-label ${info.festivals.length || info.terms.length ? 'notable' : ''}`}>{info.label}</span>
    {(info.rest || info.work) && <span className={`day-badge ${info.work ? 'work' : 'rest'}`} aria-hidden="true">{info.work ? '班' : '休'}</span>}
  </DayButton>;
}
const components={DayButton: CalendarDay};
const years=Array.from({length: MAX_YEAR-MIN_YEAR+1}, (_,i)=>MIN_YEAR+i);
export function App() {
  const [today,setToday]=useState(()=>new Date());
  const [selected,setSelected]=useState(()=>supportedDate(today) ? today : clampMonth(today));
  const [month,setMonth]=useState(()=>clampMonth(today));
  useEffect(()=>{
    // Refresh today's marker after midnight and when the panel becomes visible.
    const update=()=>setToday(new Date());
    const timer=setInterval(update,30000);
    document.addEventListener('visibilitychange',update);
    return ()=>{clearInterval(timer);document.removeEventListener('visibilitychange',update);};
  },[]);
  const info=useMemo(()=>dayInfo(selected),[selected]);
  const highlights=useMemo(()=>monthHighlights(month),[month]);
  function select(date){if (!date || !supportedDate(date)) return;setSelected(date);setMonth(clampMonth(date));}
  function move(delta){const target=new Date(month.getFullYear(),month.getMonth()+delta,1);if(supportedDate(target))setMonth(target);}
  const isFirst=month.getFullYear()===MIN_YEAR && month.getMonth()===0;
  const isLast=month.getFullYear()===MAX_YEAR && month.getMonth()===11;
  return <main>
    <section className="calendar-pane" aria-label="月历">
      <header className="toolbar">
        <div className="month-picker">
          <select aria-label="年份" value={month.getFullYear()} onChange={e=>setMonth(new Date(Number(e.target.value),month.getMonth(),1))}>{years.map(y=><option key={y} value={y}>{y}年</option>)}</select>
          <select aria-label="月份" value={month.getMonth()} onChange={e=>setMonth(new Date(month.getFullYear(),Number(e.target.value),1))}>{Array.from({length:12},(_,m)=><option key={m} value={m}>{m+1}月</option>)}</select>
        </div>
        <div className="navigation">
          <button className="today-button" disabled={!supportedDate(today)} onClick={()=>select(today)}>今天</button>
          <button aria-label="上个月" disabled={isFirst} onClick={()=>move(-1)}>‹</button>
          <button aria-label="下个月" disabled={isLast} onClick={()=>move(1)}>›</button>
        </div>
      </header>
      <DayPicker mode="single" required locale={zhCN} weekStartsOn={1} selected={selected} onSelect={select}
        month={month} onMonthChange={setMonth} today={today} startMonth={new Date(MIN_YEAR,0,1)} endMonth={new Date(MAX_YEAR,11,1)}
        disabled={[{before:new Date(MIN_YEAR,0,1)},{after:new Date(MAX_YEAR,11,31)}]}
        showOutsideDays fixedWeeks hideNavigation components={components} />
      <footer><span><i className="legend rest"/>放假</span><span><i className="legend work"/>补班</span><span className="coverage">{holidayYears.includes(month.getFullYear()) ? '中国大陆节假日' : `${month.getFullYear()}年放假安排未收录`}</span></footer>
    </section>
    <aside aria-label="日期详情">
      <section className="date-details" aria-live="polite" aria-atomic="true">
        <p className="detail-month">{selected.toLocaleDateString('zh-CN',{year:'numeric',month:'long'})}</p>
        <div className="detail-number">{selected.getDate()}</div>
        <p className="weekday">{selected.toLocaleDateString('zh-CN',{weekday:'long'})}{dateKey(selected)===dateKey(today) ? ' · 今天' : ''}</p>
        <p className="lunar-detail">{info.lunarText}</p>
        <p className="zodiac">{info.lunar.zodiac}年</p>
        {(info.festivals.length>0 || info.terms.length>0) && <p className="festival-detail">{[...info.festivals,...info.terms].join(' / ')}</p>}
        <p className={`day-type ${info.rest ? 'rest' : info.work ? 'work' : ''}`}>
          {info.rest ? `${info.holidayName} · 放假` : info.work ? `${info.holidayName} · 补班` : !info.holidayKnown ? '放假安排未收录' : [0,6].includes(selected.getDay()) ? '周末' : '工作日'}
        </p>
      </section>
      <section className="highlights" aria-label="本月节日与节气">
        <h2>本月节日与节气</h2>
        {highlights.length ? <ul>{highlights.map(item=><li key={item.key}><button onClick={()=>select(item.date)} aria-current={dateKey(selected)===item.key ? 'date' : undefined}><span>{item.date.getDate()}日</span><span>{item.names.join(' / ')}</span></button></li>)}</ul> : <p className="empty">本月暂无节日或节气</p>}
      </section>
    </aside>
  </main>;
}
if (typeof document !== 'undefined' && document.getElementById('root')) {
  createRoot(document.getElementById('root')).render(<App/>);
  ready();
}
