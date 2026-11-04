'use strict';
// In-process stand-in for NativeSupervisor.exe so chat lifecycle tests can run
// without Windows Job Objects. Same protocol: acquire a per-key lock, emit
// ready, then bridge stdio to chat-helper. A second process with the same key
// emits busy and exits. This is not the product mutex.
const { spawn } = require('node:child_process');
const { closeSync, openSync, unlinkSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { createFrameState, pushProtocolBytes, isStopLine, lineBody } = require(path.join(__dirname, '../../dist/byte-lines.cjs'));

const [lockScope, lockKey, execPath, helperPath] = process.argv.slice(2);
if (!lockScope || !lockKey || !execPath || !helperPath) process.exit(64);

const lockFile = path.join(lockScope, 'session-' + createHash('sha256').update(lockKey).digest('hex') + '.lock');
let lockFd;
try {
  lockFd = openSync(lockFile, 'wx');
} catch (error) {
  if (error && error.code === 'EEXIST') {
    process.stdout.write(JSON.stringify({ type: 'busy', detail: 'session occupied' }) + '\n', () => process.exit(3));
  } else {
    throw error;
  }
}
if (lockFd === undefined) {
  // Busy reply is flushing; do not spawn a second helper.
} else {
main();
}

function main() {
let released = false;
function release() {
  if (released) return;
  released = true;
  try { closeSync(lockFd); } catch { /* already closed */ }
  try { unlinkSync(lockFile); } catch { /* already removed */ }
}
process.on('exit', release);
// child.kill() delivers SIGTERM and skips the exit hook. Release first so the next session is not "already in use".
process.on('SIGTERM', () => { release(); process.exit(0); });
process.on('SIGINT', () => { release(); process.exit(0); });

const helper = spawn(execPath, [helperPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
});
let shuttingDown = false;
let helperExited = helper.exitCode !== null || helper.signalCode !== null;
let helperStdoutEnded = false;
let forwardedWrites = 0;
let shutdownTimer;
function finishShutdown(force = false) {
  if (released || (!force && (!helperExited || !helperStdoutEnded || forwardedWrites > 0))) return;
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = undefined; }
  release();
  process.exit(0);
}
function shutdown(killHelper) {
  if (!shuttingDown) {
    shuttingDown = true;
    // ChildProcess exit can precede its stdout end. Drain the protocol pipe before
    // exiting this stand-in, but keep the wait bounded like NativeSupervisor.
    shutdownTimer = setTimeout(() => finishShutdown(true), 2000);
    shutdownTimer.unref();
  }
  if (killHelper && !helperExited) {
    try { helper.kill(); } catch { finishShutdown(true); }
  }
  if (helper.exitCode !== null || helper.signalCode !== null) helperExited = true;
  finishShutdown();
}
helper.stdout.on('data', chunk => {
  forwardedWrites += 1;
  process.stdout.write(chunk, () => {
    forwardedWrites -= 1;
    finishShutdown();
  });
});
helper.stdout.on('end', () => { helperStdoutEnded = true; finishShutdown(); });
helper.stdout.on('close', () => { helperStdoutEnded = true; finishShutdown(); });
helper.stderr.on('data', () => { /* supervisor discards helper stderr */ });
helper.on('exit', () => { helperExited = true; shutdown(false); });
helper.stdin.on('error', () => { /* closed */ });

// Raw bytes. String concat would decode each chunk as UTF-8 and corrupt a
// Chinese character split across pipe reads (second-turn "你是谁").
const frame = createFrameState();
process.stdin.on('data', chunk => {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const lines = pushProtocolBytes(frame, buf);
  for (const line of lines) {
    if (isStopLine(line)) { shutdown(true); return; }
    try { helper.stdin.write(Buffer.concat([lineBody(line), Buffer.from('\n')])); }
    catch { /* helper already closed */ }
  }
});
process.stdin.on('end', () => shutdown(true));
process.stdout.write(JSON.stringify({ type: 'ready', detail: String(helper.pid || 0) }) + '\n');
}
