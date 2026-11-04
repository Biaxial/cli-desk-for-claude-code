'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { ChatSessionCoordinator } = require(path.join(root, 'dist/chat-session.cjs'));
const { openSupervisor } = require('./launch-supervisor.cjs');
const mockCli = path.join(root, 'tests/fixtures/mock-cli-synthetic-error.cjs');
const childProbe = spawnSync(process.execPath, ['-e', 'process.stdout.write("cc-child-ok")'], { encoding: 'utf8' });
const childSpawnAvailable = childProbe.status === 0 && childProbe.stdout === 'cc-child-ok';

function nextOf(events, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const index = events.findIndex(predicate);
      if (index >= 0) {
        clearInterval(timer);
        resolve(events.splice(index, 1)[0]);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error('timeout waiting for chat event'));
      }
    }, 25);
  });
}

test('synthetic API failure marks the turn failed without replacing the selected model', {
  skip: childSpawnAvailable ? false : '当前运行环境不允许启动测试子进程'
}, async () => {
  const events = [];
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-synthetic-'));
  const chat = new ChatSessionCoordinator(root, scope, event => events.push(event), 120000, openSupervisor);
  try {
    await chat.start('project-synthetic', process.execPath, process.cwd(), {}, [mockCli]);
    const init = await nextOf(events, event => event.type === 'init');
    assert.equal(init.model, 'claude-sonnet-4-5');

    chat.send('检查本地代理');
    const completed = await nextOf(events, event => event.type === 'turn_complete');
    await nextOf(events, event => event.type === 'state' && event.state === 'failed');

    assert.equal(completed.isError, true);
    assert.match(completed.result, /ECONNREFUSED/);
    assert.equal(chat.status(), 'failed');
    assert.equal(chat.model, 'claude-sonnet-4-5');
    assert.equal(chat.conversation().some(message => message.model === '<synthetic>'), false);
    const assistant = chat.conversation().find(message => message.role === 'assistant');
    assert.equal(assistant.state, 'error');
    assert.equal(assistant.model, undefined);
    assert.equal(events.some(event => event.type === 'assistant_start' && event.model === '<synthetic>'), false);
  } finally {
    chat.stop();
  }
});
