const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { SessionRepository } = require(path.join(root, 'dist/session-repository.cjs'));

function record(sessionId, overrides = {}) {
  return {
    sessionId, projectId: 'project-1', projectDirectory: 'C:/work/project', title: '会话', preview: '预览',
    messageCount: 2, createdAt: '2026-11-02T00:00:00.000Z', lastActiveAt: '2026-11-02T00:00:00.000Z', ...overrides
  };
}
const messages = [
  { id: 'm1', role: 'user', blocks: [{ type: 'text', text: 'hello' }], state: 'complete', createdAt: '2026-11-02T00:00:00.000Z' },
  { id: 'm2', role: 'assistant', blocks: [{ type: 'text', text: 'hi' }], state: 'complete', createdAt: '2026-11-02T00:00:01.000Z' }
];

test('session repository persists index and per-session messages', () => {
  const data = mkdtempSync(path.join(tmpdir(), 'cc-desktop-sessions-'));
  const repo = new SessionRepository(data);
  assert.deepEqual(repo.list(), []);
  repo.upsert(record('s1'));
  repo.saveMessages('s1', messages);
  assert.equal(repo.list().length, 1);
  assert.equal(repo.get('s1').sessionId, 's1');
  assert.deepEqual(repo.loadMessages('s1'), messages);
  assert.equal(new SessionRepository(data).list()[0].title, '会话');
  assert.ok(existsSync(path.join(data, 'sessions.json')));
});

test('session repository touches metadata without losing other fields', () => {
  const data = mkdtempSync(path.join(tmpdir(), 'cc-desktop-sessions-'));
  const repo = new SessionRepository(data);
  repo.upsert(record('s1'));
  repo.touch('s1', { title: '新标题', titleEdited: true, lastActiveAt: '2026-11-02T01:00:00.000Z' });
  const got = repo.get('s1');
  assert.equal(got.title, '新标题');
  assert.equal(got.titleEdited, true);
  assert.equal(got.preview, '预览');
  assert.equal(got.lastActiveAt, '2026-11-02T01:00:00.000Z');
});
