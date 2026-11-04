'use strict';
// Failed and one-shot CLI exits must settle: Chinese wording, assistant text kept,
// and a later start/send must not be stuck "already active".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { ChatSessionCoordinator, describeCliExit } = require(path.join(root, 'dist/chat-session.cjs'));
const { SessionRepository } = require(path.join(root, 'dist/session-repository.cjs'));
const { openSupervisor } = require('./launch-supervisor.cjs');
const mockCli = path.join(root, 'tests/fixtures/mock-cli.cjs');
const mockAssistant = path.join(root, 'tests/fixtures/mock-cli-assistant.cjs');
const mockKill = path.join(root, 'tests/fixtures/mock-cli-kill.cjs');

function create(events) {
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-exit-'));
  const chat = new ChatSessionCoordinator(root, scope, event => events.push(event), 120000, openSupervisor);
  return chat;
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
async function until(predicate, timeout = 8000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timeout waiting for settle');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('describeCliExit never prints a null exit code', () => {
  const missing = describeCliExit(null, null, 'spawn ENOENT');
  const signaled = describeCliExit(undefined, 'SIGKILL');
  assert.match(missing, /没有退出码/);
  assert.match(missing, /可以重新发送/);
  assert.match(signaled, /SIGKILL/);
  assert.doesNotMatch(missing, /null/);
  assert.doesNotMatch(signaled, /null/);
  assert.doesNotMatch(missing, /unexpected/);
  assert.match(describeCliExit(7, null), /退出码 7/);
});

test('a missing CLI reports a Chinese failure and does not stay busy', async () => {
  const events = [];
  const chat = create(events);
  const missing = path.join(tmpdir(), 'cc-desktop-missing-cli');
  await chat.start('project-missing', missing, process.cwd(), {});
  await nextOf(events, event => event.type === 'state' && event.state === 'failed');
  const errors = events.filter(event => event.type === 'error').map(event => event.message);
  assert.ok(errors.length > 0);
  assert.ok(errors.every(message => !/unexpected:\s*null/.test(message) && !/\bnull\b/.test(message)));
  assert.match(errors.join('\n'), /找不到 CLI|ENOENT|没有退出码|启动失败|Invalid CLI/);
  assert.equal(chat.isBusy(), false);
  assert.equal(chat.status(), 'failed');
  events.splice(0, events.length);
  await chat.start('project-missing', process.execPath, process.cwd(), {}, [mockCli]);
  const init = await nextOf(events, event => event.type === 'init');
  assert.ok(init.sessionId);
  chat.stop();
});

test('canonical assistant text is persisted when the CLI then exits', async () => {
  const events = [];
  const repo = new SessionRepository(mkdtempSync(path.join(tmpdir(), 'cc-desktop-exit-store-')));
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-exit-'));
  let live;
  const wrapped = event => {
    events.push(event);
    const sessionId = live && live.sessionIdValue();
    if (!sessionId) return;
    if (event.type === 'transcript' || event.type === 'assistant_end' || event.type === 'turn_complete' || event.type === 'init' || event.type === 'user_message') {
      repo.saveMessages(sessionId, live.conversation());
    }
  };
  live = new ChatSessionCoordinator(root, scope, wrapped, 120000, openSupervisor);
  await live.start('project-assistant', process.execPath, process.cwd(), {}, [mockAssistant]);
  await nextOf(events, event => event.type === 'state' && event.state === 'completed');
  live.send('hello');
  await nextOf(events, event => event.type === 'turn_complete');
  await until(() => live.status() === 'completed' && live.acceptsSend() === false);
  const saved = repo.loadMessages(live.sessionIdValue());
  assert.deepEqual(saved.map(message => message.role), ['user', 'assistant']);
  const assistant = saved[1];
  assert.equal(assistant.state, 'complete');
  assert.equal(assistant.blocks.some(block => block.type === 'text' && block.text === 'VISIBLE-ASSISTANT'), true);
  const tool = assistant.blocks.find(block => block.type === 'tool_use');
  assert.equal(tool.name, 'Read');
  assert.equal(tool.input, '{"file":"a.ts"}');
  assert.equal(JSON.stringify(saved).includes('hidden chain'), false);
  assert.equal(live.isBusy(), false);
  assert.equal(events.some(event => event.type === 'error' && /unexpected:\s*null|\bnull\b/.test(event.message)), false);
  await live.ensureAcceptingSend();
  live.send('again');
  await nextOf(events, event => event.type === 'turn_complete' && event.result === 'VISIBLE-ASSISTANT');
  await until(() => live.status() === 'completed' && live.acceptsSend() === false);
  assert.deepEqual(live.conversation().map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(live.isBusy(), false);
  events.splice(0, events.length);
  await live.start('project-assistant', process.execPath, process.cwd(), {}, [mockCli]);
  const init = await nextOf(events, event => event.type === 'init');
  assert.ok(init.sessionId);
  assert.equal(live.isBusy(), false);
  live.stop();
});

test('a signal or non-zero exit keeps partial assistant text and allows a new session', async () => {
  const events = [];
  const chat = create(events);
  await chat.start('project-kill', process.execPath, process.cwd(), {}, [mockKill]);
  await nextOf(events, event => event.type === 'state' && event.state === 'completed');
  chat.send('hello');
  await nextOf(events, event => event.type === 'text_delta' && event.text.includes('PARTIAL'));
  // POSIX reports SIGKILL with no numeric code. Windows has no POSIX signals,
  // so the same forced termination commonly arrives as a non-zero exit code.
  const failure = await nextOf(events, event => event.type === 'error' && /没有退出码|信号|退出码\s+\d+/.test(event.message));
  assert.doesNotMatch(failure.message, /null/);
  assert.doesNotMatch(failure.message, /unexpected/);
  await until(() => chat.status() === 'failed' && chat.isBusy() === false);
  const assistant = chat.conversation().find(message => message.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant.state, 'error');
  assert.equal(assistant.blocks.some(block => block.type === 'text' && block.text.includes('PARTIAL')), true);
  assert.equal(JSON.stringify(assistant.blocks).includes('do not persist'), false);
  events.splice(0, events.length);
  await chat.start('project-kill', process.execPath, process.cwd(), {}, [mockCli]);
  const init = await nextOf(events, event => event.type === 'init');
  assert.ok(init.sessionId);
  assert.equal(chat.isBusy(), false);
  chat.stop();
});
