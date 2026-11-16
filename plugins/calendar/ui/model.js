import chineseDays from 'chinese-days';
import arrangements from 'chinese-days/dist/chinese-days.json' with {type: 'json'};

// Keep calendar calculations in local civil dates; never convert via UTC strings.
export const MIN_YEAR = 1901;
export const MAX_YEAR = 2099;
export const holidayYears = [...new Set(Object.keys(arrangements.holidays).map(key => Number(key.slice(0, 4))))].sort((a,b) => a-b);
const coveredYears = new Set(holidayYears);
const solarFestivals = {'01-01':'元旦','05-01':'劳动节','10-01':'国庆节'};
export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function supportedDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime()) && date.getFullYear() >= MIN_YEAR && date.getFullYear() <= MAX_YEAR;
}
export function clampMonth(date) {
  return new Date(Math.min(MAX_YEAR, Math.max(MIN_YEAR, date.getFullYear())), date.getMonth(), 1);
}
export function dayInfo(date) {
  if (!supportedDate(date)) return null;
  const key = dateKey(date);
  const lunar = chineseDays.getLunarDate(key);
  const festivals = chineseDays.getLunarFestivals(key).flatMap(item => item.name);
  if (solarFestivals[key.slice(5)]) festivals.unshift(solarFestivals[key.slice(5)]);
  const terms = chineseDays.getSolarTerms(key).map(item => item.name);
  const holidayKnown = coveredYears.has(date.getFullYear());
  const rest = holidayKnown && Object.hasOwn(arrangements.holidays, key);
  const work = holidayKnown && Object.hasOwn(arrangements.workdays, key);
  const holidayName = (rest ? arrangements.holidays[key] : work ? arrangements.workdays[key] : '')?.split(',')[1] || '';
  const lunarLabel = lunar.lunarDay === 1 ? lunar.lunarMonCN : lunar.lunarDayCN;
  return {key, lunar, festivals: [...new Set(festivals)], terms, holidayKnown, rest, work, holidayName,
    label: festivals[0] || terms[0] || lunarLabel,
    lunarText: `${lunar.yearCyl}年 ${lunar.isLeap ? '闰' : ''}${lunar.lunarMonCN}${lunar.lunarDayCN}`};
}
export function monthHighlights(month) {
  const result=[];
  for (let day=1; day<=new Date(month.getFullYear(), month.getMonth()+1, 0).getDate(); day++) {
    const date = new Date(month.getFullYear(), month.getMonth(), day), info = dayInfo(date);
    const names=[...info.festivals, ...info.terms];
    if (names.length) result.push({date, key: info.key, names});
  }
  return result;
}
