'use strict';
// Session lifecycle: a completed CLI process must not block the next session,
// and a genuinely in-flight turn must still be rejected.
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
const mockHang = path.join(root, 'tests/fixtures/mock-cli-hang.cjs');

function create(events, timeout = 120000) {
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-life-'));
  const chat = new ChatSessionCoordinator(root, scope, event => events.push(event), timeout, openSupervisor);
  return { chat, scope };
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
async function turn(chat, events, text) {
  chat.send(text);
  let streamed = '';
  for (;;) {
    const event = await nextOf(events, item => item.type === 'text_delta' || item.type === 'turn_complete');
    if (event.type === 'text_delta') streamed += event.text;
    else return { event, streamed };
  }
}

test('after a normal completed turn, start() for a new session succeeds', async () => {
  const events = [];
  const { chat } = create(events);
  await chat.start('project-life', process.execPath, process.cwd(), {}, [mockCli]);
  const first = await nextOf(events, event => event.type === 'init');
  const reply = await turn(chat, events, 'hi');
  assert.equal(reply.streamed, 'MOCK:hi');
  assert.equal(chat.status(), 'completed');
  // The warm CLI is kept for a follow-up on the same session.
  const second = await turn(chat, events, 'again');
  assert.equal(second.event.result, 'MOCK:again');
  assert.equal(chat.sessionIdValue(), first.sessionId);

  await chat.start('project-life', process.execPath, process.cwd(), {}, [mockCli]);
  const next = await nextOf(events, event => event.type === 'init');
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(chat.status(), 'completed');
  const fresh = await turn(chat, events, 'new');
  assert.equal(fresh.event.result, 'MOCK:new');
  assert.equal(chat.status(), 'completed');
  chat.stop();
});

test('several sessions can be created in sequence', async () => {
  const events = [];
  const { chat } = create(events);
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    await chat.start('project-seq', process.execPath, process.cwd(), {}, [mockCli]);
    const init = await nextOf(events, event => event.type === 'init');
    ids.push(init.sessionId);
    const done = await turn(chat, events, 'm' + index);
    assert.equal(done.event.result, 'MOCK:m' + index);
    assert.equal(chat.status(), 'completed');
  }
  assert.equal(new Set(ids).size, 3);
  chat.stop();
});

test('a second start is rejected while a turn is genuinely active', async () => {
  const events = [];
  const { chat } = create(events);
  await chat.start('project-busy', process.execPath, process.cwd(), {}, [mockHang]);
  await nextOf(events, event => event.type === 'init');
  chat.send('hold');
  assert.equal(chat.status(), 'generating');
  assert.throws(() => { void chat.start('project-busy', process.execPath, process.cwd(), {}, [mockCli]); }, /A chat session is already active/);
  assert.equal(chat.status(), 'generating');
  // Replacing a settled session also holds the guard until the new process is launched.
  chat.stop();
  await nextOf(events, event => event.type === 'state' && event.state === 'interrupted');
  const replacement = chat.start('project-busy', process.execPath, process.cwd(), {}, [mockCli]);
  assert.throws(() => { void chat.start('project-busy', process.execPath, process.cwd(), {}, [mockCli]); }, /A chat session is already active/);
  await replacement;
  const init = await nextOf(events, event => event.type === 'init');
  assert.ok(init.sessionId);
  chat.stop();
});

test('two coordinators still cannot run the same project at once', async () => {
  const firstEvents = [];
  const secondEvents = [];
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-life-lock-'));
  const first = new ChatSessionCoordinator(root, scope, event => firstEvents.push(event), 120000, openSupervisor);
  const second = new ChatSessionCoordinator(root, scope, event => secondEvents.push(event), 120000, openSupervisor);
  await first.start('project-lock', process.execPath, process.cwd(), {}, [mockCli]);
  await nextOf(firstEvents, event => event.type === 'init');
  await second.start('project-lock', process.execPath, process.cwd(), {}, [mockCli]);
  await nextOf(secondEvents, event => event.type === 'state' && event.state === 'failed');
  assert.ok(secondEvents.some(event => event.type === 'error' && event.message === 'This session is already in use'));
  first.stop();
  await nextOf(firstEvents, event => event.type === 'state' && event.state === 'interrupted');
  let started = false;
  for (let attempt = 0; attempt < 20 && !started; attempt += 1) {
    secondEvents.splice(0, secondEvents.length);
    await second.start('project-lock', process.execPath, process.cwd(), {}, [mockCli]);
    const event = await nextOf(secondEvents, item => item.type === 'init' || (item.type === 'state' && item.state === 'failed'), 5000);
    if (event.type === 'init') { started = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(started, true);
  second.stop();
});

test('after stop, a new session can start', async () => {
  const events = [];
  const { chat } = create(events);
  await chat.start('project-stop', process.execPath, process.cwd(), {}, [mockCli]);
  await nextOf(events, event => event.type === 'init');
  chat.send('hi');
  await nextOf(events, event => event.type === 'state' && event.state === 'generating');
  chat.stop();
  await nextOf(events, event => event.type === 'state' && event.state === 'interrupted');
  assert.equal(chat.status(), 'interrupted');
  // Drop events from the interrupted turn so the next assertion observes only the new session.
  events.splice(0, events.length);
  await chat.start('project-stop', process.execPath, process.cwd(), {}, [mockCli]);
  await nextOf(events, event => event.type === 'init');
  const done = await turn(chat, events, 'after-stop');
  assert.equal(done.event.result, 'MOCK:after-stop');
  assert.equal(chat.status(), 'completed');
  chat.stop();
});

test('after a simulated CLI abnormal exit, a new session can start', async () => {
  const events = [];
  const { chat } = create(events);
  await chat.start('project-crash', process.execPath, process.cwd(), {}, [mockFail]);
  await nextOf(events, event => event.type === 'state' && event.state === 'failed');
  assert.equal(chat.status(), 'failed');
  assert.ok(events.some(event => event.type === 'error'));
  await chat.start('project-crash', process.execPath, process.cwd(), {}, [mockCli]);
  const init = await nextOf(events, event => event.type === 'init');
  assert.ok(init.sessionId);
  const done = await turn(chat, events, 'recovered');
  assert.equal(done.event.isError, false);
  assert.equal(done.event.result, 'MOCK:recovered');
  assert.equal(chat.status(), 'completed');
  chat.stop();
});
