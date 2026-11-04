'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const {
  resolveChatLaunch, cliArgsFor, summarizeConversation, transcriptAfterLaunch, sessionBelongsToProject, assertSafeSessionId
} = require(path.join(root, 'dist/resume-plan.cjs'));

function record(sessionId, projectId, lastActiveAt) {
  return {
    sessionId, projectId, projectDirectory: 'C:/work/' + projectId, title: 't', preview: 'p',
    messageCount: 2, createdAt: lastActiveAt, lastActiveAt
  };
}

test('continueLatest uses the newest verified session for the active project', () => {
  const records = [
    record('older', 'p1', '2026-11-01T00:00:00.000Z'),
    record('newer', 'p1', '2026-11-03T00:00:00.000Z'),
    record('other-project', 'p2', '2026-11-04T00:00:00.000Z')
  ];
  const resolved = resolveChatLaunch({ continueLatest: true }, records, 'p1');
  assert.deepEqual(resolved, { resumeSessionId: 'newer' });
  assert.equal(sessionBelongsToProject(records, 'p1', resolved.resumeSessionId), true);
  assert.equal(sessionBelongsToProject(records, 'p1', 'other-project'), false);
});

test('continueLatest without an index entry falls back to native --continue', () => {
  const resolved = resolveChatLaunch({ continueLatest: true }, [record('elsewhere', 'p2', '2026-11-04T00:00:00.000Z')], 'p1');
  assert.deepEqual(resolved, { continueLatest: true });
  const args = cliArgsFor(resolved, ['mock-cli.cjs']);
  assert.deepEqual(args, ['mock-cli.cjs', '--continue']);
  assert.equal(args.includes('--resume'), false);
});

test('explicit resume wins and is passed as --resume without --continue', () => {
  const resolved = resolveChatLaunch({ resumeSessionId: 'sess_1', continueLatest: true }, [], 'p1');
  assert.deepEqual(resolved, { resumeSessionId: 'sess_1' });
  const args = cliArgsFor(resolved);
  assert.equal(args.at(-2), '--resume');
  assert.equal(args.at(-1), 'sess_1');
  assert.equal(args.includes('--continue'), false);
  assert.equal(args.includes('--output-format'), true);
});

test('resume rejects a flag-like session id', () => {
  assert.throws(() => assertSafeSessionId('--resume'), /Invalid session id/);
  assert.throws(() => resolveChatLaunch({ resumeSessionId: '--continue' }, [], 'p1'), /Invalid session id/);
});

test('summarize uses the first user turn and hides thinking', () => {
  const summary = summarizeConversation([
    { id: 'u', role: 'user', blocks: [{ type: 'text', text: '  fix   the   resume  flow please keep going past eighty characters so the title has to be cut cleanly at the limit' }], state: 'complete', createdAt: '2026-11-03T00:00:00.000Z' },
    { id: 'a', role: 'assistant', blocks: [{ type: 'thinking', thinking: 'secret chain of thought' }, { type: 'text', text: 'Restored the transcript.' }, { type: 'tool_use', name: 'Read', input: '{}' }], state: 'complete', createdAt: '2026-11-03T00:00:01.000Z' }
  ]);
  assert.equal(summary.title.startsWith('fix the resume flow'), true);
  assert.equal(summary.title.length <= 80, true);
  assert.equal(summary.preview, 'Restored the transcript.');
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.preview.includes('secret'), false);
});

test('a renamed title is kept and sessionTitleFromMessages matches it', () => {
  const { sessionTitleFromMessages } = require(path.join(root, 'dist/resume-plan.cjs'));
  const messages = [
    { id: 'u', role: 'user', blocks: [{ type: 'text', text: '你是谁' }], state: 'complete', createdAt: '2026-11-03T00:00:00.000Z' },
    { id: 'a', role: 'assistant', blocks: [{ type: 'text', text: '独立助手。' }], state: 'complete', createdAt: '2026-11-03T00:00:01.000Z' }
  ];
  const summary = summarizeConversation(messages, { title: '我的名字', titleEdited: true, preview: '' });
  assert.equal(summary.title, '我的名字');
  assert.equal(summary.preview, '独立助手。');
  assert.equal(sessionTitleFromMessages(messages), '你是谁');
});

test('summarize falls back to the tool name when the assistant has no text', () => {
  const summary = summarizeConversation([
    { id: 'u', role: 'user', blocks: [{ type: 'text', text: 'look' }], state: 'complete', createdAt: '2026-11-03T00:00:00.000Z' },
    { id: 'a', role: 'assistant', blocks: [{ type: 'tool_use', name: 'Grep', input: '{}' }], state: 'complete', createdAt: '2026-11-03T00:00:01.000Z' }
  ], { title: '旧标题', preview: '旧摘要' });
  assert.equal(summary.title, 'look');
  assert.equal(summary.preview, '工具 Grep');
});

test('transcriptAfterLaunch clears a new session and keeps a restored one', () => {
  const messages = [
    { id: 'u', role: 'user', blocks: [{ type: 'text', text: 'hello' }], state: 'complete', createdAt: '2026-11-03T00:00:00.000Z' },
    { id: 'a', role: 'assistant', blocks: [{ type: 'text', text: 'hi' }], state: 'complete', createdAt: '2026-11-03T00:00:01.000Z' }
  ];
  assert.deepEqual(transcriptAfterLaunch('new', { sessionId: 'sess', messages }), { sessionId: undefined, messages: [] });
  const restored = transcriptAfterLaunch('resume', { sessionId: 'sess', messages });
  assert.equal(restored.sessionId, 'sess');
  assert.deepEqual(restored.messages.map(message => message.role), ['user', 'assistant']);
  const continued = transcriptAfterLaunch('continue', { sessionId: 'newer', messages });
  assert.equal(continued.messages[1].blocks[0].text, 'hi');
  continued.messages[1].blocks[0].text = 'mutated';
  assert.equal(messages[1].blocks[0].text, 'hi');
});
