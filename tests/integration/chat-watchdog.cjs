const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { ChatSessionCoordinator } = require(path.join(root, 'dist/chat-session.cjs'));
const { openSupervisor } = require('./launch-supervisor.cjs');
const mockCli = path.join(root, 'tests/fixtures/mock-cli.cjs');
const mockHang = path.join(root, 'tests/fixtures/mock-cli-hang.cjs');

function nextOf(events, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const idx = events.findIndex(predicate);
      if (idx >= 0) { clearInterval(timer); resolve(events.splice(idx, 1)[0]); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timeout waiting for event')); }
    }, 25);
  });
}

test('watchdog surfaces a hung CLI as a clear failure instead of infinite generating', async () => {
  const events = [];
  const chat = new ChatSessionCoordinator(root, mkdtempSync(path.join(tmpdir(), 'cc-wd-')), e => events.push(e), 2000, openSupervisor);
  chat.start('project-wd', process.execPath, process.cwd(), {}, [mockHang]);
  await nextOf(events, e => e.type === 'init');
  chat.send('hello');
  // the mock never emits a result; the no-progress watchdog must transition to failed
  await nextOf(events, e => e.type === 'state' && e.state === 'failed', 15000);
  assert.ok(events.some(e => e.type === 'error' && /No response from CLI/.test(e.message)));
  // after failure the coordinator must be able to start a fresh session
  const fresh = [];
  const chat2 = new ChatSessionCoordinator(root, mkdtempSync(path.join(tmpdir(), 'cc-wd2-')), e => fresh.push(e), 2000, openSupervisor);
  chat2.start('project-wd', process.execPath, process.cwd(), {}, [mockCli]);
  await nextOf(fresh, e => e.type === 'init');
  chat2.send('again');
  await nextOf(fresh, e => e.type === 'turn_complete');
  chat2.stop();
  await new Promise(resolve => setTimeout(resolve, 800));
});

test('send() gives an accurate hint when there is no active session', () => {
  const chat = new ChatSessionCoordinator(root, mkdtempSync(path.join(tmpdir(), 'cc-wd3-')), () => {}, 2000, openSupervisor);
  assert.throws(() => chat.send('hello'), /尚未创建会话/);
  assert.equal(chat.status(), 'idle');
});

test('send() after a failed session asks to start a new one', async () => {
  const events = [];
  const chat = new ChatSessionCoordinator(root, mkdtempSync(path.join(tmpdir(), 'cc-wd4-')), e => events.push(e), 2000, openSupervisor);
  chat.start('p', process.execPath, process.cwd(), {}, [path.join(root, 'tests/fixtures/mock-cli-fail.cjs')]);
  await nextOf(events, e => e.type === 'state' && e.state === 'failed', 15000);
  assert.throws(() => chat.send('hello'), /会话已结束/);
  assert.equal(chat.status(), 'failed');
});
