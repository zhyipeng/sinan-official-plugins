import test from 'node:test';
import assert from 'node:assert/strict';
import {pasteFailureMessage} from '../ui/platform.js';
test('粘贴失败提示按平台显示，并保留原错误',()=>{
 for(const [platform,expected] of [['MacIntel','辅助功能'],['Win32','高权限'],['Linux aarch64','Wayland']]){const message=pasteFailureMessage('粘贴失败',platform);assert.ok(message.startsWith('粘贴失败'));assert.ok(message.includes(expected));if(platform!=='MacIntel')assert.ok(!message.includes('macOS'));}
});
