const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { ChatSessionCoordinator } = require(path.join(root, 'dist/chat-session.cjs'));
const { openSupervisor } = require('./launch-supervisor.cjs');
const mockCli = path.join(root, 'tests/fixtures/mock-cli.cjs');
const mockFail = path.join(root, 'tests/fixtures/mock-cli-fail.cjs');

function coordinator(onEvent) {
  return new ChatSessionCoordinator(root, mkdtempSync(path.join(tmpdir(), 'cc-desktop-chat-')), onEvent, 120000, openSupervisor);
}
function nextOf(events, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const idx = events.findIndex(predicate);
      if (idx >= 0) { clearInterval(timer); resolve(events.splice(idx, 1)[0]); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timeout waiting for chat event')); }
    }, 25);
  });
}

test('chat coordinator maps mock stream-json into ordered, complete messages', async () => {
  const events = [];
  const chat = coordinator(e => events.push(e));
  chat.start('project-1', process.execPath, process.cwd(), {}, [mockCli]);
  const init = await nextOf(events, e => e.type === 'init');
  assert.ok(init.sessionId);
  chat.send('hello');
  await nextOf(events, e => e.type === 'user_message');
  await nextOf(events, e => e.type === 'assistant_start');
  let streamed = '';
  for (;;) {
    const delta = await nextOf(events, e => e.type === 'text_delta' || e.type === 'turn_complete');
    if (delta.type === 'text_delta') streamed += delta.text;
    else { assert.equal(streamed, 'MOCK:hello'); assert.equal(delta.result, 'MOCK:hello'); assert.equal(delta.isError, false); break; }
  }
  // second turn
  chat.send('again');
  const second = await nextOf(events, e => e.type === 'turn_complete');
  assert.equal(second.result, 'MOCK:again');
  chat.stop();
  await new Promise(resolve => setTimeout(resolve, 800));
});

test('chat coordinator reports failed state on abnormal CLI exit', async () => {
  const events = [];
  const chat = coordinator(e => events.push(e));
  chat.start('project-2', process.execPath, process.cwd(), {}, [mockFail]);
  await nextOf(events, e => e.type === 'state' && e.state === 'failed');
  assert.ok(events.some(e => e.type === 'error'));
});

test('chat coordinator reports failed state when CLI cannot start', async () => {
  const events = [];
  const chat = coordinator(e => events.push(e));
  chat.start('project-3', 'C:/nonexistent/claude.exe', process.cwd(), {});
  await nextOf(events, e => e.type === 'state' && e.state === 'failed', 20000);
});

test('chat coordinator enforces the shared per-project mutex', async () => {
  const first = [];
  const second = [];
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-mutex-'));
  const a = new ChatSessionCoordinator(root, scope, e => first.push(e), 120000, openSupervisor);
  const b = new ChatSessionCoordinator(root, scope, e => second.push(e), 120000, openSupervisor);
  a.start('project-x', process.execPath, process.cwd(), {}, [mockCli]);
  await nextOf(first, e => e.type === 'init');
  b.start('project-x', process.execPath, process.cwd(), {}, [mockCli]);
  await nextOf(second, e => e.type === 'state' && e.state === 'failed');
  assert.ok(second.some(e => e.type === 'error'));
  a.stop();
  await new Promise(resolve => setTimeout(resolve, 800));
});
