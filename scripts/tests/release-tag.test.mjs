import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseTag,tagForPlugin} from '../release-tag.mjs';
test('同仓库不同插件可以使用相同版本号',()=>{
 assert.equal(releaseTag({id:'tools.calendar',version:'0.1.0'}),'tools.calendar-v0.1.0');
 assert.equal(releaseTag({id:'tools.clipboard',version:'0.1.0'}),'tools.clipboard-v0.1.0');
});
test('标签读取实际清单，拒绝无效 ID、版本与目录',async()=>{
 assert.equal(await tagForPlugin('calendar'),'tools.calendar-v0.1.2');
 for(const manifest of [{id:'tools.calendar\n',version:'0.1.0'},{id:'tools.calendar',version:'0.1.0\n'},{id:'../escape',version:'0.1.0'},{id:'system.settings',version:'0.1.0'},{id:'tools.calendar',version:'01.0.0'},{id:'tools.calendar',version:'1.0.0/../x'},{id:'tools.calendar',version:'1.0.0-rc.1'},{id:'tools.calendar',version:'9007199254740992.0.0'}])assert.throws(()=>releaseTag(manifest));
 await assert.rejects(()=>tagForPlugin('../calendar'));
});
