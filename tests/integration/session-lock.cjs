const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const exe = path.join(root, 'dist/native/NativeSupervisor.exe');
const fixture = path.join(root, 'tests/integration/synthetic-child.cjs');
function launch(scope, id) {
  const p = spawn(exe, [scope, id, process.execPath, fixture], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = ''; const messages = []; const waiters = [];
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', data => {
    buffer += data; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const parsed = JSON.parse(line); messages.push(parsed);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  return { p, async next() {
    if (!messages.length) await Promise.race([new Promise(resolve => waiters.push(resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('Supervisor timeout')), 5000))]);
    return messages.shift();
  }, async done() { return new Promise(resolve => p.once('exit', resolve)); } };
}
function exists(pid) {
  const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty ProcessId)`], { encoding: 'utf8' });
  return result.trim() === String(pid);
}
const skip = process.platform === 'win32' ? false : 'NativeSupervisor job-object mutex is Windows-only; re-run npm test on Windows';
test('same session competes, different session independent, crash releases mutex and owned process tree', { skip }, async () => {
  const scope = mkdtempSync(path.join(tmpdir(), 'cc-desktop-lock-'));
  const first = launch(scope, 'session-one');
  const firstReady = await first.next();
  assert.equal(firstReady.type, 'ready');
  const descendant = await first.next();
  assert.equal(descendant.type, 'descendant');
  assert.equal(exists(Number(descendant.detail)), true);
  const denied = launch(scope, 'session-one');
  assert.equal((await denied.next()).type, 'busy');
  await denied.done();
  const distinct = launch(scope, 'session-two');
  assert.equal((await distinct.next()).type, 'ready');
  const secondDescendant = await distinct.next();
  assert.equal(secondDescendant.type, 'descendant');
  first.p.kill(); await first.done();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(exists(Number(firstReady.detail)), false);
  assert.equal(exists(Number(descendant.detail)), false);
  const recovered = launch(scope, 'session-one');
  assert.equal((await recovered.next()).type, 'ready');
  await recovered.next();
  for (const item of [distinct, recovered]) { item.p.stdin.write('stop\n'); await item.done(); }
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(exists(Number(secondDescendant.detail)), false);
});
