import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const dir=await mkdtemp(fileURLToPath(new URL('./.render-',import.meta.url)));
try{
 const output=join(dir,'app.mjs');
 await build({entryPoints:[fileURLToPath(new URL('../ui/app.jsx',import.meta.url))],outfile:output,bundle:true,packages:'external',format:'esm',platform:'node',plugins:[{name:'omit-css',setup(b){b.onResolve({filter:/\.css$/},args=>({path:args.path,namespace:'empty'}));b.onLoad({filter:/.*/,namespace:'empty'},()=>({contents:'',loader:'js'}));}}]});
 const {App}=await import(pathToFileURL(output));
 test('真实页面无界面渲染计算行、历史、新建、删除及备份',()=>{const html=renderToStaticMarkup(React.createElement(App));for(const label of ['计算稿纸','历史稿纸','新稿纸','删除稿纸','第 1 行表达式','备份'])assert.ok(html.includes(label),label);assert.match(html,/aria-current="page"/);assert.match(html,/role="status"/);assert.doesNotMatch(html,/<script|<style|style="|https?:\/\//);});
 test('插件仅声明已有搜索、执行与隔离存储能力',async()=>{const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url)));assert.equal(manifest.id,'tools.calculator');assert.equal(manifest.runtime.kind,'process');assert.equal(manifest.contributes.searchProviders[0].id,'expressions');assert.equal(manifest.contributes.commands.find(c=>c.id==='copy').execution,'direct');assert.deepEqual(manifest.contributes.uiViews[0].permissions,['storage']);assert.deepEqual(manifest.permissions,['clipboard.write']);});
}finally{await rm(dir,{recursive:true,force:true});}
