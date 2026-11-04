import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { isPlainObject } from '../../shared/contracts';
import { CMD_BOM_MESSAGE, hasUtf8Bom, quoteWindowsCmdCommand } from '../cli/validate-cli';
import { createFrameState, decodeProtocolLine, pushProtocolBytes } from './byte-lines';

type StartCommand = { type: 'start'; cwd: string; cliPath: string; args: string[] };
type UserCommand = { type: 'user'; message: string };
type ControlCommand = { type: 'control'; response: Record<string, unknown> };
type KillCommand = { type: 'kill' };
type Command = StartCommand | UserCommand | ControlCommand | KillCommand;

let child: ChildProcessWithoutNullStreams | undefined;
// CLI stdout and stderr stay on their own buffers. Protocol stdin is framed
// separately in protocolFrame so a split UTF-8 character cannot mix with a CLI event.
let stdoutBuffer = '';
let stderrBuffer = '';
let stderrTail = '';
let lastError = '';
let stopping = false;
let exitReported = false;
let stdoutEnded = false;
let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
let exitFallback: NodeJS.Timeout | undefined;

function emit(event: object): void { process.stdout.write(JSON.stringify(event) + '\n'); }

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  // Keep the timer referenced. An unref'd timer can be skipped when this helper
  // is hosted by Electron-as-Node, leaving the supervisor mutex held.
  setTimeout(() => process.exit(0), 40);
}

function stop(): void {
  if (stopping) return;
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill(); return; } catch { /* already exited */ }
  }
  shutdown();
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    // Strip the desktop host's own session markers so the spawned CLI behaves like a
    // normal user launch and persists its session for --resume/--continue.
    if (key === 'CLAUDECODE' || key === 'ELECTRON_RUN_AS_NODE' || /^CLAUDE_CODE_|^CLAUDE_EFFORT$|^CLAUDE_PID$/.test(key)) delete env[key];
  }
  return env;
}

function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function spawnCli(cliPath: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  const options = { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (cliPath.toLowerCase().endsWith('.cmd')) {
    if (hasUtf8Bom(cliPath)) throw new Error(CMD_BOM_MESSAGE);
    const comSpec = process.env.ComSpec || (process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
      : 'cmd.exe');
    const command = quoteWindowsCmdCommand([quoteCmdArg(cliPath), ...args.map(quoteCmdArg)].join(' '));
    return spawn(comSpec, ['/d', '/s', '/c', command], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(cliPath, args, options);
}

function drainLines(buffer: string, onLine: (line: string) => void): string {
  let end: number;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (line.trim()) onLine(line);
  }
  return buffer;
}

function publishCliLine(line: string): void {
  let trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (trimmed.charCodeAt(0) === 0xfeff) trimmed = trimmed.slice(1);
  if (!trimmed.trim()) return;
  try { emit({ type: 'cli', data: JSON.parse(trimmed) }); }
  catch { emit({ type: 'raw', text: trimmed }); }
}

function flushStdout(): void {
  if (!stdoutBuffer.trim()) {
    stdoutBuffer = '';
    return;
  }
  const pending = stdoutBuffer;
  stdoutBuffer = '';
  publishCliLine(pending);
}

function rememberStderr(text: string): void {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return;
  stderrTail = `${stderrTail}\n${clean}`.trim().slice(-500);
}

function reportExit(code: number | null, signal: NodeJS.Signals | null): void {
  if (exitReported) return;
  exitStatus = { code, signal };
  if (!stdoutEnded && !exitFallback) {
    // ChildProcess 'exit' can precede the final readable stdout data. Give the
    // stream time to drain; inherited handles can keep it open, so bound the wait.
    exitFallback = setTimeout(() => finishExit(true), 2000);
  }
  finishExit(false);
}

function finishExit(force: boolean): void {
  if (exitReported || !exitStatus || (!stdoutEnded && !force)) return;
  if (exitReported) return;
  exitReported = true;
  if (exitFallback) { clearTimeout(exitFallback); exitFallback = undefined; }
  if (force && !stdoutEnded) child?.stdout.destroy();
  flushStdout();
  if (stderrBuffer.trim()) {
    rememberStderr(stderrBuffer);
    emit({ type: 'stderr', text: stderrBuffer.trim().slice(0, 500) });
    stderrBuffer = '';
  }
  const detail = lastError || stderrTail || undefined;
  emit({ type: 'exit', ...exitStatus, detail });
  child = undefined;
  shutdown();
}

function start(message: StartCommand): void {
  if (child || stopping) return;
  if (!path.isAbsolute(message.cwd) || !path.isAbsolute(message.cliPath)) throw new Error('Invalid CLI or project path');
  if (!Array.isArray(message.args) || message.args.some(arg => typeof arg !== 'string')) throw new Error('Invalid CLI arguments');
  child = spawnCli(message.cliPath, message.args, message.cwd);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (exitReported) return;
    stdoutBuffer = drainLines(stdoutBuffer + chunk, publishCliLine);
  });
  child.stdout.on('end', () => {
    stdoutEnded = true;
    finishExit(false);
  });
  child.stdout.on('close', () => {
    stdoutEnded = true;
    finishExit(false);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer = drainLines(stderrBuffer + chunk, line => {
      rememberStderr(line);
      emit({ type: 'stderr', text: line.slice(0, 500) });
    });
  });
  child.on('error', error => {
    lastError = error.message;
    emit({ type: 'error', message: error.message });
  });
  child.on('exit', (code, signal) => reportExit(code, signal));
  // 'close' also covers spawn failures, which may not emit 'exit'. By then
  // stdio has closed, so it is safe to flush the remaining protocol buffers.
  child.on('close', (code, signal) => {
    if (!exitStatus) reportExit(code, signal);
    stdoutEnded = true;
    finishExit(false);
  });
  emit({ type: 'spawned' });
}

function receive(message: Command): void {
  if (message.type === 'start' && !child && !stopping) {
    start(message);
  } else if (message.type === 'user' && child) {
    if (typeof message.message !== 'string' || message.message.length === 0 || message.message.length > 262144) throw new Error('Invalid user message');
    const payload = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: message.message }] } };
    // One UTF-8 line. JSON.stringify escapes controls; the pipe must not recode the bytes.
    child.stdin.write(Buffer.from(JSON.stringify(payload) + '\n', 'utf8'));
  } else if (message.type === 'control' && child) {
    child.stdin.write(Buffer.from(JSON.stringify({ type: 'control_response', response: message.response }) + '\n', 'utf8'));
  } else if (message.type === 'kill') {
    stop();
  }
}

// Binary stdin. A UTF-8 character may be split across reads; decode only a full LF frame.
const protocolFrame = createFrameState();
process.stdin.on('data', (chunk: Buffer) => {
  const lines = pushProtocolBytes(protocolFrame, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  for (const line of lines) {
    const text = decodeProtocolLine(line);
    if (!text.trim()) continue;
    try {
      const data: unknown = JSON.parse(text);
      if (!isPlainObject(data) || typeof data.type !== 'string') throw new Error('Invalid protocol message');
      receive(data as Command);
    } catch (error) { emit({ type: 'error', message: error instanceof Error ? error.message : 'Invalid protocol message' }); stop(); }
  }
  if (protocolFrame.pending.length > 1024 * 1024) { emit({ type: 'error', message: 'Protocol input exceeds limit' }); stop(); }
});
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
