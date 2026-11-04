'use strict';
// Real Claude Code CLI integration test — exercises the full chat coordinator chain
// against the actual CLI. Run explicitly via `npm run test:cli` (spends API tokens).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, existsSync } = require('node:fs');
const { tmpdir, homedir } = require('node:os');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { ChatSessionCoordinator } = require(path.join(root, 'dist/chat-session.cjs'));
const { validateCliPath } = require(path.join(root, 'dist/validate-cli.cjs'));

function findCli() {
  if (process.env.CLI_DESK_CLI) return process.env.CLI_DESK_CLI;
  if (process.env.CC_DESKTOP_CLI) return process.env.CC_DESKTOP_CLI;
  const candidates = [
    path.join(homedir(), '.local', 'bin', 'claude.exe'),
    path.join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try { const p = execFileSync('where', ['claude'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]; if (p) return p; } catch { /* not on PATH */ }
  return null;
}
function nextOf(events, predicate, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const idx = events.findIndex(predicate);
      if (idx >= 0) { clearInterval(timer); resolve(events.splice(idx, 1)[0]); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timeout waiting for event')); }
    }, 50);
  });
}
function launch(events) {
  return new ChatSessionCoordinator(root, mkdtempSync(path.join(tmpdir(), 'cc-desktop-cli-')), e => events.push(e));
}

const cli = findCli();
const skip = cli ? false : 'Claude Code CLI not found; set CLI_DESK_CLI (or legacy CC_DESKTOP_CLI) to run the real CLI test';

test('real CLI: create session, stream, multi-turn, and resume', { skip }, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cc-desktop-real-'));
  const validated = validateCliPath(cli);
  const events = [];
  const chat = launch(events);
  chat.start('real-project', validated, cwd, {});
  await nextOf(events, e => e.type === 'state' && e.state === 'completed');

  // turn 1: the CLI emits its init (session id) only after the first user message
  chat.send('Reply with exactly: ACCEPTANCE_OK');
  const init = await nextOf(events, e => e.type === 'init');
  assert.ok(init.sessionId, 'session id must be captured from CLI init');
  const sessionId = init.sessionId;
  await nextOf(events, e => e.type === 'assistant_start');
  let streamed = '';
  for (;;) {
    const delta = await nextOf(events, e => e.type === 'text_delta' || e.type === 'turn_complete');
    if (delta.type === 'text_delta') streamed += delta.text;
    else { assert.ok(streamed.includes('ACCEPTANCE_OK'), `streamed "${streamed}" should contain ACCEPTANCE_OK`); assert.equal(delta.isError, false); break; }
  }

  // turn 2: continuous interaction
  chat.send('Reply with exactly: SECOND_OK');
  const second = await nextOf(events, e => e.type === 'turn_complete');
  assert.equal(second.isError, false);
  chat.stop();
  await new Promise(resolve => setTimeout(resolve, 800));

  // resume the same native session and confirm the CLI continues it
  const resumeEvents = [];
  const resumed = launch(resumeEvents);
  resumed.start('real-project', validated, cwd, { resumeSessionId: sessionId });
  await nextOf(resumeEvents, e => e.type === 'state' && e.state === 'completed');
  resumed.send('Reply with exactly: RESUMED_OK');
  const resumeInit = await nextOf(resumeEvents, e => e.type === 'init');
  assert.equal(resumeInit.sessionId, sessionId, 'resume must restore the same native session id');
  const resumedResult = await nextOf(resumeEvents, e => e.type === 'turn_complete');
  assert.equal(resumedResult.isError, false);
  resumed.stop();
  await new Promise(resolve => setTimeout(resolve, 800));
}, { timeout: 300000 });

test('real CLI: user interrupt stops generation', { skip }, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cc-desktop-real-'));
  const events = [];
  const chat = launch(events);
  chat.start('real-interrupt', validateCliPath(cli), cwd, {});
  await nextOf(events, e => e.type === 'state' && e.state === 'completed');
  chat.send('Write a short poem about the sea, one line at a time');
  await nextOf(events, e => e.type === 'assistant_start');
  chat.stop();
  await nextOf(events, e => e.type === 'state' && e.state === 'interrupted');
}, { timeout: 120000 });
