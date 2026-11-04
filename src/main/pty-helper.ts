import * as pty from 'node-pty';
import path from 'node:path';
import { HelperCommand, clampDimension, isPlainObject } from '../shared/contracts';

let terminal: pty.IPty | undefined;
let buffer = '';
let stopping = false;
function emit(event: object): void { process.stdout.write(JSON.stringify(event) + '\n'); }
function stop(): void {
  if (stopping) return;
  stopping = true;
  terminal?.kill();
  if (!terminal) process.exit(0);
}
function receive(message: HelperCommand): void {
  if (message.type === 'start' && !terminal && !stopping) {
    if (!path.isAbsolute(message.cwd) || !path.isAbsolute(message.cliPath)) throw new Error('Invalid CLI or project path');
    const cols = clampDimension(message.cols, 20, 400), rows = clampDimension(message.rows, 5, 200);
    const isCmd = message.cliPath.toLowerCase().endsWith('.cmd');
    const executable = isCmd ? (process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')) : message.cliPath;
    const args = isCmd ? `/d /s /c ""${message.cliPath}""` : [];
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;
    terminal = pty.spawn(executable, args, { cwd: message.cwd, env, name: 'xterm-256color', cols, rows, useConpty: true });
    emit({ type: 'started', pid: terminal.pid, cols, rows });
    terminal.onData(data => emit({ type: 'data', data }));
    terminal.onExit(({ exitCode, signal }) => {
      emit({ type: 'exit', exitCode, signal });
      terminal = undefined;
      setTimeout(() => process.exit(0), 50).unref();
    });
  } else if (message.type === 'write' && terminal && typeof message.data === 'string' && message.data.length <= 65536) terminal.write(message.data);
  else if (message.type === 'resize' && terminal) terminal.resize(clampDimension(message.cols, 20, 400), clampDimension(message.rows, 5, 200));
  else if (message.type === 'kill') stop();
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) { emit({ type: 'error', message: 'Protocol input exceeds limit' }); stop(); return; }
  let end: number;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const data: unknown = JSON.parse(line);
      if (!isPlainObject(data) || typeof data.type !== 'string') throw new Error('Invalid protocol message');
      receive(data as HelperCommand);
    } catch (error) { emit({ type: 'error', message: error instanceof Error ? error.message : 'Invalid protocol message' }); stop(); }
  }
});
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
