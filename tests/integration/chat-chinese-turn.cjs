'use strict';
// Second send after a settled turn must carry Chinese as UTF-8 JSON, even when
// the supervisor pipe delivers one byte at a time (the Windows re-encode bug).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { ChatSessionCoordinator } = require(path.join(root, 'dist/chat-session.cjs'));
const { openSupervisor } = require('./launch-supervisor.cjs');
const mockEcho = path.join(root, 'tests/fixtures/mock-cli-echo.cjs');
const mockCli = path.join(root, 'tests/fixtures/mock-cli.cjs');

function chunkingSupervisor(lockScope, lockKey, helperPath) {
  const child = openSupervisor(lockScope, lockKey, helperPath);
  const stdin = child.stdin;
  const write = stdin.write.bind(stdin);
  stdin.write = (data, encoding, cb) => {
    const callback = typeof encoding === 'function' ? encoding : cb;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), typeof encoding === 'string' ? encoding : 'utf8');
    for (let i = 0; i < buf.length; i++) write(buf.subarray(i, i + 1));
    if (typeof callback === 'function') callback();
    return true;
  };
  return child;
}

function nextOf(events, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const idx = events.findIndex(predicate);
      if (idx >= 0) { clearInterval(timer); resolve(events.splice(idx, 1)[0]); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timeout waiting for chat event: ' + predicate)); }
    }, 20);
  });
}

async function until(predicate, timeout = 8000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timeout waiting for settle');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('byte-split stdin still delivers a second Chinese turn after the CLI exits', async () => {
  const events = [];
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-zh-'));
  const chat = new ChatSessionCoordinator(root, scope, event => events.push(event), 120000, chunkingSupervisor);
  await chat.start('project-zh', process.execPath, process.cwd(), {}, [mockEcho]);
  await nextOf(events, event => event.type === 'state' && event.state === 'completed');
  chat.send('你好');
  const first = await nextOf(events, event => event.type === 'turn_complete');
  assert.equal(first.result, '你好');
  assert.equal(first.isError, false);
  await until(() => chat.status() === 'completed' && chat.acceptsSend() === false);
  const sessionId = chat.sessionIdValue();
  assert.ok(sessionId);
  events.splice(0, events.length);
  await chat.ensureAcceptingSend();
  chat.send('你是谁');
  const second = await nextOf(events, event => event.type === 'turn_complete');
  assert.equal(second.result, '你是谁');
  assert.equal(second.isError, false);
  assert.equal(chat.sessionIdValue(), sessionId);
  const roles = chat.conversation().map(message => message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant']);
  assert.equal(chat.conversation()[2].blocks[0].text, '你是谁');
  assert.equal(events.some(event => event.type === 'error' && /control character|Bad control/.test(event.message || '')), false);
  chat.stop();
});

test('a warm CLI accepts two Chinese turns on the same stdin', async () => {
  const events = [];
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-zh-warm-'));
  const chat = new ChatSessionCoordinator(root, scope, event => events.push(event), 120000, chunkingSupervisor);
  await chat.start('project-zh-warm', process.execPath, process.cwd(), {}, [mockCli]);
  await nextOf(events, event => event.type === 'init');
  chat.send('你好');
  const first = await nextOf(events, event => event.type === 'turn_complete');
  assert.equal(first.result, 'MOCK:你好');
  chat.send('你是谁');
  const second = await nextOf(events, event => event.type === 'turn_complete' && event.result === 'MOCK:你是谁');
  assert.equal(second.isError, false);
  assert.equal(events.some(event => event.type === 'error' && /control character/.test(event.message || '')), false);
  chat.stop();
});
