import path from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HelperCommand, SessionState, TerminalEvent } from '../../shared/contracts';

type Listener = (event: TerminalEvent) => void;
export class SessionCoordinator {
  private supervisor?: ChildProcessWithoutNullStreams;
  private state: SessionState = 'idle';
  private ownerToken?: string;
  private buffer = '';
  private started = false;
  private completed = false;
  constructor(private readonly root: string, private readonly lockScope: string, private readonly emit: Listener) {}
  status(): SessionState { return this.state; }
  /** True only while this terminal still owns a live supervisor. A stale status must not block chat. */
  isRunning(): boolean {
    return !!this.supervisor && (this.state === 'active' || this.state === 'starting' || this.state === 'stopping');
  }
  private setState(state: SessionState, message?: string): void {
    this.state = state; this.emit({ type: 'status', state, message });
  }
  start(sessionId: string, cliPath: string, cwd: string, cols: number, rows: number): void {
    if (this.supervisor && ['idle', 'exited', 'failed', 'busy'].includes(this.state)) {
      try { this.supervisor.kill(); } catch { /* already exited */ }
      this.supervisor = undefined;
    }
    if (!['idle', 'exited', 'failed', 'busy'].includes(this.state) || this.supervisor) throw new Error('Session already starting or active');
    this.started = false; this.completed = false; this.buffer = '';
    const token = randomUUID(); this.ownerToken = token;
    this.setState('starting');
    const exe = path.join(this.root, 'dist/native/NativeSupervisor.exe');
    const helper = path.join(this.root, 'dist/pty-helper.cjs');
    const child = spawn(exe, [this.lockScope, sessionId, process.execPath, helper], {
      cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    this.supervisor = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.ownerToken !== token) return;
      this.buffer += chunk;
      if (this.buffer.length > 1024 * 1024) { this.setState('failed', 'Supervisor message exceeds limit'); this.stop(); return; }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const event = JSON.parse(line) as TerminalEvent & { detail?: string };
          if (event.type === 'busy') { this.setState('busy', 'This Session is already in use'); continue; }
          if (event.type === 'ready') { this.started = true; this.command({ type: 'start', cliPath, cwd, cols, rows }); continue; }
          if (event.type === 'started') { this.setState('active'); this.emit(event); continue; }
          if (event.type === 'data' && typeof event.data === 'string') { this.emit(event); continue; }
          if (event.type === 'exit') {
            this.completed = true;
            const code = typeof event.exitCode === 'number' ? event.exitCode : null;
            const message = code === null ? 'CLI 已退出（没有退出码）' : `CLI 已退出（退出码 ${code}）`;
            this.emit(event);
            this.setState(code === 0 ? 'exited' : 'failed', message);
            continue;
          }
          if (event.type === 'error') { this.emit({ type: 'error', message: event.message }); this.setState('failed', event.message); }
        } catch { this.emit({ type: 'error', message: 'Invalid supervisor message' }); this.stop(); }
      }
    });
    child.stderr.on('data', () => this.emit({ type: 'error', message: 'Supervisor failed to start or assign process job' }));
    child.on('error', (error) => { if (this.ownerToken === token) this.setState('failed', error.message); });
    child.on('exit', (code) => {
      if (this.ownerToken !== token) return;
      this.supervisor = undefined; this.ownerToken = undefined;
      if (!this.completed && this.state !== 'busy' && this.state !== 'stopping') {
        const message = typeof code === 'number' ? `监督进程已退出（退出码 ${code}）` : '监督进程已退出（没有退出码）';
        this.setState('failed', message);
      }
      else if (this.state === 'stopping') this.setState('exited', 'Stopped by user');
    });
  }
  private command(message: HelperCommand): void {
    if (this.supervisor?.stdin.writable) this.supervisor.stdin.write(JSON.stringify(message) + '\n');
  }
  write(data: string): void {
    if (this.state !== 'active' || data.length > 65536) throw new Error('Terminal not active or input too large');
    this.command({ type: 'write', data });
  }
  resize(cols: number, rows: number): void {
    if (this.state === 'active') this.command({ type: 'resize', cols, rows });
  }
  stop(): void {
    if (!this.supervisor || this.state === 'stopping') return;
    this.setState('stopping');
    const child = this.supervisor;
    this.command({ type: 'kill' });
    setTimeout(() => { if (this.supervisor === child && child.stdin.writable) child.stdin.write('stop\n'); }, 3000).unref();
  }
}
