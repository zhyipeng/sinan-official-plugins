import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const dir=await mkdtemp(fileURLToPath(new URL('./.render-',import.meta.url)));
try{
 const output=join(dir,'app.mjs');
 await build({entryPoints:[fileURLToPath(new URL('../ui/app.jsx',import.meta.url))],outfile:output,bundle:true,packages:'external',format:'esm',platform:'node',plugins:[{name:'omit-css-for-ssr',setup(b){b.onResolve({filter:/\.css$/},args=>({path:args.path,namespace:'empty-css'}));b.onLoad({filter:/.*/,namespace:'empty-css'},()=>({contents:'',loader:'js'}));}}]});
 const {App,CalendarDay}=await import(pathToFileURL(output));
 test('真实组件无界面渲染月历、42 天网格与中文日期导航',()=>{
  const html=renderToStaticMarkup(React.createElement(App));
  assert.equal((html.match(/role="gridcell"/g)||[]).length,42);
  for(const label of ['年份','月份','上个月','下个月','本月节日与节气','日期详情'])assert.ok(html.includes(label),label);
  assert.match(html,/class="lunar-label/);assert.match(html,/aria-selected="true"/);
  assert.doesNotMatch(html,/<script|<style|style="|https?:\/\//);
 });
 test('自定义日期保留可访问性属性和组件焦点处理',()=>{
  const html=renderToStaticMarkup(React.createElement(CalendarDay,{day:{date:new Date(2026,1,14)},modifiers:{},tabIndex:0,'aria-label':'2026年2月14日',type:'button'}));
  assert.match(html,/tabindex="0"/);assert.match(html,/aria-label="2026年2月14日，农历/);assert.match(html,/调休补班/);assert.match(html,/>班<\/span>/);
 });
}finally{await rm(dir,{recursive:true,force:true});}
