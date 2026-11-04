'use strict';
// Coordinator stability across turns, stop/resume, session replacement, and fresh chats.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { ChatSessionCoordinator } = require(path.join(root, 'dist/chat-session.cjs'));
const { openSupervisor } = require('./launch-supervisor.cjs');
const mockCli = path.join(root, 'tests/fixtures/mock-cli.cjs');
const mockCliSlow = path.join(root, 'tests/fixtures/mock-cli-slow.cjs');

function create(events) {
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-stability-'));
  return new ChatSessionCoordinator(root, scope, event => events.push(event), 120000, openSupervisor);
}

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

async function turn(chat, events, text) {
  chat.send(text);
  let streamed = '';
  for (;;) {
    const event = await nextOf(events, item => item.type === 'text_delta' || item.type === 'turn_complete');
    if (event.type === 'text_delta') streamed += event.text;
    else return { event, streamed };
  }
}

function firstText(message) {
  return message.blocks.find(block => block.type === 'text')?.text ?? '';
}

test('three turns keep transcript order and one session id', async () => {
  const events = [];
  const chat = create(events);
  await chat.start('stability-multi', process.execPath, process.cwd(), {}, [mockCli]);
  const init = await nextOf(events, event => event.type === 'init');
  const sessionId = init.sessionId;

  for (const question of ['first question', 'second question', 'third question']) {
    const reply = await turn(chat, events, question);
    assert.equal(reply.streamed, `MOCK:${question}`);
    assert.equal(reply.event.result, `MOCK:${question}`);
    assert.equal(chat.sessionIdValue(), sessionId);
    assert.equal(chat.status(), 'completed');
  }

  const transcript = chat.conversation();
  assert.deepEqual(transcript.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(transcript.map(firstText), [
    'first question', 'MOCK:first question',
    'second question', 'MOCK:second question',
    'third question', 'MOCK:third question'
  ]);
  chat.stop();
});

test('stopping mid-stream preserves partial text and a resumed session accepts another send', async () => {
  const events = [];
  const chat = create(events);
  await chat.start('stability-stop', process.execPath, process.cwd(), {}, [mockCliSlow]);
  const init = await nextOf(events, event => event.type === 'init');
  chat.send('interrupted question');
  await nextOf(events, event => event.type === 'text_delta' && event.text.includes('PARTIAL-STOP'));
  chat.stop();
  await nextOf(events, event => event.type === 'state' && event.state === 'interrupted');

  const partial = chat.conversation().find(message => message.role === 'assistant');
  assert.ok(partial);
  assert.equal(partial.state, 'interrupted');
  assert.equal(firstText(partial), 'PARTIAL-STOP');
  const prior = chat.conversation();

  events.splice(0, events.length);
  await chat.start('stability-stop', process.execPath, process.cwd(), { resumeSessionId: init.sessionId }, [mockCli], prior);
  const resumed = await nextOf(events, event => event.type === 'init');
  assert.equal(resumed.sessionId, init.sessionId);
  assert.equal(chat.sessionIdValue(), init.sessionId);
  assert.deepEqual(chat.conversation().map(message => message.state), ['complete', 'interrupted']);

  const reply = await turn(chat, events, 'after stop');
  assert.equal(reply.event.result, 'MOCK:after stop');
  assert.equal(chat.status(), 'completed');
  assert.deepEqual(chat.conversation().map(firstText), [
    'interrupted question', 'PARTIAL-STOP', 'after stop', 'MOCK:after stop'
  ]);
  chat.stop();
});

test('replacing a session with a resumed session keeps only the new transcript', async () => {
  const events = [];
  const chat = create(events);
  await chat.start('stability-switch', process.execPath, process.cwd(), {}, [mockCli]);
  const sessionA = await nextOf(events, event => event.type === 'init');
  const replyA = await turn(chat, events, 'A conversation');
  assert.equal(replyA.event.result, 'MOCK:A conversation');

  const sessionBId = 'resume-session-B';
  const transcriptB = [
    { id: 'b-user', role: 'user', blocks: [{ type: 'text', text: 'B earlier question' }], state: 'complete', createdAt: '2026-11-04T00:00:00.000Z' },
    { id: 'b-assistant', role: 'assistant', blocks: [{ type: 'text', text: 'B earlier answer' }], state: 'complete', model: 'mock-model', createdAt: '2026-11-04T00:00:01.000Z' }
  ];
  events.splice(0, events.length);
  await chat.start('stability-switch', process.execPath, process.cwd(), { resumeSessionId: sessionBId }, [mockCli], transcriptB);
  const sessionB = await nextOf(events, event => event.type === 'init');
  assert.notEqual(sessionA.sessionId, sessionB.sessionId);
  assert.equal(sessionB.sessionId, sessionBId);
  assert.deepEqual(chat.conversation().map(firstText), ['B earlier question', 'B earlier answer']);

  const replyB = await turn(chat, events, 'B new question');
  assert.equal(replyB.event.result, 'MOCK:B new question');
  assert.equal(replyB.streamed, 'MOCK:B new question');
  assert.deepEqual(chat.conversation().map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(chat.conversation().map(firstText), ['B earlier question', 'B earlier answer', 'B new question', 'MOCK:B new question']);
  assert.equal(JSON.stringify(chat.conversation()).includes('A conversation'), false);
  assert.equal(chat.sessionIdValue(), sessionBId);
  chat.stop();
});

test('starting a fresh chat while idle clears the transcript and gets a new id', async () => {
  const events = [];
  const chat = create(events);
  await chat.start('stability-fresh', process.execPath, process.cwd(), {}, [mockCli]);
  const first = await nextOf(events, event => event.type === 'init');
  await turn(chat, events, 'previous chat');
  assert.equal(chat.status(), 'completed');

  events.splice(0, events.length);
  await chat.start('stability-fresh', process.execPath, process.cwd(), {}, [mockCli]);
  assert.deepEqual(chat.conversation(), []);
  const second = await nextOf(events, event => event.type === 'init');
  assert.notEqual(second.sessionId, first.sessionId);
  assert.deepEqual(chat.conversation(), []);
  const reply = await turn(chat, events, 'new chat');
  assert.equal(reply.event.result, 'MOCK:new chat');
  assert.deepEqual(chat.conversation().map(firstText), ['new chat', 'MOCK:new chat']);
  chat.stop();
});
