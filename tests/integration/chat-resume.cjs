'use strict';
// Resume / continue: assistant turns are part of the persisted transcript,
// restoring that transcript keeps both roles, and a busy turn still cannot be replaced.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { ChatSessionCoordinator } = require(path.join(root, 'dist/chat-session.cjs'));
const { SessionRepository } = require(path.join(root, 'dist/session-repository.cjs'));
const { resolveChatLaunch, summarizeConversation } = require(path.join(root, 'dist/resume-plan.cjs'));
const { openSupervisor } = require('./launch-supervisor.cjs');
const mockCli = path.join(root, 'tests/fixtures/mock-cli.cjs');
const mockRich = path.join(root, 'tests/fixtures/mock-cli-rich.cjs');
const mockHang = path.join(root, 'tests/fixtures/mock-cli-hang.cjs');

function create(events, timeout = 120000) {
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-resume-'));
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
function priorTranscript() {
  return [
    { id: 'user-1', role: 'user', blocks: [{ type: 'text', text: 'earlier question' }], state: 'complete', createdAt: '2026-11-03T00:00:00.000Z' },
    { id: 'assistant-1', role: 'assistant', blocks: [{ type: 'text', text: 'earlier answer' }, { type: 'tool_use', name: 'Read', input: '{"file":"a.ts"}' }], state: 'complete', model: 'mock-model', createdAt: '2026-11-03T00:00:01.000Z' }
  ];
}

test('assistant messages are persisted on turn_complete, without thinking', async () => {
  const events = [];
  const { chat } = create(events);
  const repo = new SessionRepository(mkdtempSync(path.join(tmpdir(), 'cc-desktop-resume-store-')));
  const persist = () => {
    const sessionId = chat.sessionIdValue();
    const conversation = chat.conversation();
    repo.saveMessages(sessionId, conversation);
    return conversation;
  };
  await chat.start('project-resume', process.execPath, process.cwd(), {}, [mockRich]);
  await nextOf(events, event => event.type === 'init');
  chat.send('inspect');
  const done = await nextOf(events, event => event.type === 'turn_complete');
  assert.equal(done.isError, false);
  const saved = persist();
  const reloaded = repo.loadMessages(chat.sessionIdValue());
  assert.deepEqual(reloaded.map(message => message.role), ['user', 'assistant']);
  const assistant = reloaded[1];
  assert.equal(assistant.state, 'complete');
  assert.equal(assistant.blocks.some(block => block.type === 'thinking'), false);
  assert.equal(assistant.blocks.some(block => block.type === 'text' && block.text === 'VISIBLE'), true);
  const tool = assistant.blocks.find(block => block.type === 'tool_use');
  assert.equal(tool.name, 'Read');
  assert.equal(tool.input, '{"file":"a.ts"}');
  assert.equal(JSON.stringify(reloaded).includes('internal analysis'), false);
  const summary = summarizeConversation(saved);
  assert.equal(summary.title, 'inspect');
  assert.equal(summary.preview, 'VISIBLE');
  chat.stop();
});

test('seed loads user and assistant turns and the next turn keeps the resumed session id', async () => {
  const events = [];
  const { chat } = create(events);
  const prior = priorTranscript();
  await chat.start('project-resume', process.execPath, process.cwd(), { resumeSessionId: 'known-session' }, [mockCli], prior);
  assert.equal(chat.sessionIdValue(), 'known-session');
  assert.deepEqual(chat.conversation().map(message => [message.role, message.blocks[0].text]), [
    ['user', 'earlier question'],
    ['assistant', 'earlier answer']
  ]);
  const init = await nextOf(events, event => event.type === 'init');
  assert.equal(init.sessionId, 'known-session');
  assert.equal(chat.conversation().length, 2);
  chat.send('next');
  const done = await nextOf(events, event => event.type === 'turn_complete');
  assert.equal(done.result, 'MOCK:next');
  const conversation = chat.conversation();
  assert.deepEqual(conversation.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(conversation[0].blocks[0].text, 'earlier question');
  assert.equal(conversation[1].blocks[0].text, 'earlier answer');
  assert.equal(conversation[2].blocks[0].text, 'next');
  assert.equal(conversation[3].blocks.some(block => block.type === 'text' && block.text === 'MOCK:next'), true);
  assert.equal(chat.sessionIdValue(), 'known-session');
  chat.stop();
});

test('continueLatest populates the conversation from the latest project record', async () => {
  const records = [
    { sessionId: 'older', projectId: 'project-resume', projectDirectory: 'C:/work', title: 'old', preview: '', messageCount: 2, createdAt: '2026-11-01T00:00:00.000Z', lastActiveAt: '2026-11-01T00:00:00.000Z' },
    { sessionId: 'latest-session', projectId: 'project-resume', projectDirectory: 'C:/work', title: 'new', preview: 'earlier answer', messageCount: 2, createdAt: '2026-11-03T00:00:00.000Z', lastActiveAt: '2026-11-03T00:00:00.000Z' },
    { sessionId: 'other', projectId: 'elsewhere', projectDirectory: 'C:/other', title: 'x', preview: '', messageCount: 1, createdAt: '2026-11-04T00:00:00.000Z', lastActiveAt: '2026-11-04T00:00:00.000Z' }
  ];
  const resolved = resolveChatLaunch({ continueLatest: true }, records, 'project-resume');
  assert.equal(resolved.resumeSessionId, 'latest-session');
  const events = [];
  const { chat } = create(events);
  await chat.start('project-resume', process.execPath, process.cwd(), resolved, [mockCli], priorTranscript());
  assert.equal(chat.sessionIdValue(), 'latest-session');
  assert.deepEqual(chat.conversation().map(message => message.role), ['user', 'assistant']);
  const init = await nextOf(events, event => event.type === 'init');
  assert.equal(init.sessionId, 'latest-session');
  chat.send('continue-please');
  await nextOf(events, event => event.type === 'turn_complete');
  assert.equal(chat.conversation().length, 4);
  assert.equal(chat.sessionIdValue(), 'latest-session');
  chat.stop();
});

test('continueLatest with no index entry uses native --continue and starts empty', async () => {
  const resolved = resolveChatLaunch({ continueLatest: true }, [], 'project-resume');
  assert.equal(resolved.continueLatest, true);
  const events = [];
  const { chat } = create(events);
  await chat.start('project-resume', process.execPath, process.cwd(), resolved, [mockCli]);
  assert.equal(chat.conversation().length, 0);
  const init = await nextOf(events, event => event.type === 'init');
  assert.equal(init.sessionId, 'continued-session');
  chat.stop();
});

test('a new session clears a restored transcript', async () => {
  const events = [];
  const { chat } = create(events);
  await chat.start('project-resume', process.execPath, process.cwd(), { resumeSessionId: 'known-session' }, [mockCli], priorTranscript());
  await nextOf(events, event => event.type === 'init');
  assert.equal(chat.conversation().length, 2);
  assert.equal(chat.status(), 'completed');
  events.splice(0, events.length);
  await chat.start('project-resume', process.execPath, process.cwd(), {}, [mockCli]);
  assert.equal(chat.conversation().length, 0);
  const init = await nextOf(events, event => event.type === 'init');
  assert.notEqual(init.sessionId, 'known-session');
  assert.equal(chat.sessionIdValue(), init.sessionId);
  chat.stop();
});

test('resume rejects a second start while a turn is active', async () => {
  const events = [];
  const { chat } = create(events);
  await chat.start('project-resume', process.execPath, process.cwd(), {}, [mockHang]);
  await nextOf(events, event => event.type === 'init');
  chat.send('hold');
  assert.equal(chat.status(), 'generating');
  const roles = chat.conversation().map(message => message.role);
  const sessionId = chat.sessionIdValue();
  assert.throws(() => {
    void chat.start('project-resume', process.execPath, process.cwd(), { resumeSessionId: 'known-session' }, [mockCli], priorTranscript());
  }, /A chat session is already active/);
  assert.throws(() => {
    void chat.start('project-resume', process.execPath, process.cwd(), { continueLatest: true }, [mockCli], priorTranscript());
  }, /A chat session is already active/);
  assert.equal(chat.status(), 'generating');
  assert.deepEqual(chat.conversation().map(message => message.role), roles);
  assert.equal(chat.sessionIdValue(), sessionId);
  assert.notEqual(sessionId, 'known-session');
  chat.stop();
});
