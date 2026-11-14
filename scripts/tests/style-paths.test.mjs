import test from 'node:test';
import assert from 'node:assert/strict';
import {editorSource,styleModuleSource} from '../style-paths.mjs';
test('CSS 提取钩子同时匹配 Windows 和 POSIX 源路径',()=>{
 for(const base of ['/work/node_modules/','C:\\work\\node_modules\\']){const separator=base.includes('\\')?'\\':'/';assert.ok(editorSource.test(base+['vanilla-jsoneditor','index.js'].join(separator)));assert.ok(styleModuleSource.test(base+['style-mod','src','style-mod.js'].join(separator)));}
 assert.ok(!editorSource.test('/work/vanilla-jsoneditor/index.js.map'));
});
