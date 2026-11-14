import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedTargets,targets} from '../targets.mjs';
test('显式目标不受调用者 Go 环境影响',()=>{assert.deepEqual(selectedTargets(['--target=windows-arm64','--target=linux-amd64']),['windows-arm64','linux-amd64']);assert.deepEqual(selectedTargets(['--all']),targets);for(const args of [['windows-amd64'],['--target=unknown-arm64'],['--all','--target=darwin-arm64'],['--target=linux-amd64','--target=linux-amd64']])assert.throws(()=>selectedTargets(args));});
