import path from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ChatBlock, ChatEvent, ChatLaunch, ChatMessage, ChatState, isPlainObject } from '../../shared/contracts';
import { cliArgsFor } from '../../shared/resume-plan';
import { isSyntheticModel, looksLikeApiError, usableModel } from '../../shared/error-hints';

type Listener = (event: ChatEvent) => void;
type HelperEvent = { type: string; subtype?: string; [key: string]: unknown };
type CliEvent = { type: string; subtype?: string; [key: string]: unknown };
type ReadyWaiter = (error?: Error) => void;
/** Test seam. Production launches NativeSupervisor.exe. */
export type SupervisorLauncher = (lockScope: string, lockKey: string, helperPath: string) => ChildProcessWithoutNullStreams;

type LaunchContext = { lockKey: string; cliPath: string; cwd: string; baseArgs?: string[] };

/** User-facing wording for a missing or non-numeric CLI exit status. Never interpolates null. */
export function describeCliExit(code: unknown, signal: unknown, detail?: string): string {
  const hasCode = typeof code === 'number';
  const signalText = typeof signal === 'string' && signal.trim() ? signal.trim() : '';
  let message: string;
  if (!hasCode && !signalText) {
    message = 'Claude CLI 意外退出（没有退出码）。进程可能没有真正启动，或被系统直接结束。';
  } else if (!hasCode) {
    message = `Claude CLI 被信号 ${signalText} 结束（没有退出码）。`;
  } else if (code === 0) {
    message = 'Claude CLI 已退出。';
  } else {
    message = `Claude CLI 意外退出（退出码 ${code}）。`;
  }
  const extra = detail?.replace(/\s+/g, ' ').trim();
  if (extra) message += ` ${extra.slice(0, 240)}`;
  message += ' 可以重新发送，或新建会话后再试。';
  return message;
}

export function describeCliFailure(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  if (/ENOENT/.test(text)) return '找不到 CLI 可执行文件（ENOENT）。请在设置中重新选择 claude.exe，不要使用带 UTF-8 BOM 的 .cmd。可以重新发送，或新建会话后再试。';
  if (/EACCES|EPERM/.test(text)) return '没有权限启动 CLI。请检查所选文件是否允许执行。可以重新发送，或新建会话后再试。';
  if (/BOM/.test(text)) return text.endsWith('。') ? `${text} 可以重新发送，或新建会话后再试。` : `${text}。可以重新发送，或新建会话后再试。`;
  if (/EINVAL|UNKNOWN|ENOTSUP/.test(text)) return '系统拒绝启动这个 CLI 文件。请改选 claude.exe，或确认 .cmd 没有 UTF-8 BOM。可以重新发送，或新建会话后再试。';
  if (/没有退出码|意外退出|可以重新发送/.test(text)) return text;
  return text ? `Claude CLI 出错：${text.slice(0, 240)} 可以重新发送，或新建会话后再试。` : 'Claude CLI 出错。可以重新发送，或新建会话后再试。';
}

export class ChatSessionCoordinator {
  private supervisor?: ChildProcessWithoutNullStreams;
  private state: ChatState = 'idle';
  private ownerToken?: string;
  private buffer = '';
  private sessionId?: string;
  private model?: string;
  private messages: ChatMessage[] = [];
  private currentId?: string;
  private blocks: ChatBlock[] = [];
  private toolInput = '';
  private turnStarted = false;
  private stopping = false;
  private turnCostUsd?: number;
  /** The open assistant reply came from the CLI itself (model <synthetic>), e.g. an API error. */
  private syntheticTurn = false;
  private startPayload?: { cwd: string; cliPath: string; args: string[] };
  private launchContext?: LaunchContext;
  private lastActivityAt = 0;
  private watchdogTimer?: NodeJS.Timeout;
  /** True while a settled supervisor is being torn down so a new session can start. */
  private handoff = false;
  /** Previous supervisor process that must exit before another CLI may spawn. */
  private blockingChild?: ChildProcessWithoutNullStreams;
  /** Transcript to install inside launch(), after reset and before any CLI event. */
  private pendingMessages?: ChatMessage[];
  /** Index session id this launch is resuming. Cleared if the CLI reports a different id. */
  private seededFromId?: string;
  /** The CLI process has exited, so the supervisor must not keep the project lock. */
  private cliGone = false;
  /** A result event already accepted this turn, so a later process exit is not a new failure. */
  private turnAccepted = false;
  private lastFailure?: string;
  private readyWaiters: ReadyWaiter[] = [];
  constructor(private readonly root: string, private readonly lockScope: string, private readonly emit: Listener, private readonly noProgressTimeoutMs = 120000, private readonly launchSupervisor?: SupervisorLauncher) {}

  status(): ChatState { return this.state; }
  sessionIdValue(): string | undefined { return this.sessionId; }
  isBusy(): boolean { return this.handoff || this.isBusyState(); }
  acceptsSend(): boolean {
    // cliGone covers the gap after the CLI exits and before the supervisor process itself quits.
    return !this.handoff && !this.cliGone && this.state === 'completed' && !!this.supervisor?.stdin.writable;
  }
  conversation(): ChatMessage[] { return this.messages.map(m => ({ ...m, blocks: m.blocks.map(b => ({ ...b })) })); }
  seed(messages: ChatMessage[]): void {
    this.messages = messages.map(m => ({ ...m, blocks: m.blocks.map(b => ({ ...b })) }));
  }

  private setState(state: ChatState, message?: string): void {
    this.state = state;
    if (message && (state === 'failed' || state === 'interrupted')) this.lastFailure = message;
    this.emit({ type: 'state', state, message });
    if (state === 'completed' || state === 'failed' || state === 'interrupted') this.flushReady(state, message);
  }
  private flushReady(state: ChatState, message?: string): void {
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) {
      if (state === 'completed') waiter();
      else waiter(new Error(message || this.lastFailure || '会话未能就绪'));
    }
  }
  private command(message: object): void {
    this.writeSupervisor(JSON.stringify(message) + '\n');
  }

  /** UTF-8 bytes, never a platform text encoding. Chinese on later turns stays valid JSON. */
  private writeSupervisor(text: string, child = this.supervisor): void {
    if (!child?.stdin.writable) return;
    child.stdin.write(Buffer.from(text, 'utf8'));
  }

  /**
   * A session is active only while a turn is in flight (starting, generating, waiting)
   * or a replacement is already tearing the previous process down.
   * After a normal result the CLI process stays up so send() can continue the same
   * session; that warm process is not an active session. start() releases it first.
   * The busy-state throw is synchronous so a second start cannot slip past the guard.
   */
  start(lockKey: string, cliPath: string, cwd: string, launch: ChatLaunch, cliArgs?: string[], initialMessages?: ChatMessage[]): Promise<void> {
    if (this.handoff || this.isBusyState()) throw new Error('A chat session is already active');
    // Captured before any await so a resumed transcript survives reset() and is visible
    // before the CLI prints its first event.
    this.pendingMessages = initialMessages;
    if (this.supervisor || this.blockingChild) {
      this.handoff = true;
      if (this.supervisor) this.blockingChild = this.detachSupervisor();
      // Mark the turn busy before yielding so a second start() still hits the guard
      // and the main-process isBusy() check rejects project/terminal changes.
      this.setState('starting');
      return this.finishHandoff(lockKey, cliPath, cwd, launch, cliArgs);
    }
    this.launch(lockKey, cliPath, cwd, launch, cliArgs);
    return Promise.resolve();
  }

  /**
   * After a settled turn the CLI may already have exited. Relaunch the same session
   * (resume when we have a native id) so the next send is not a dead end.
   */
  async ensureAcceptingSend(): Promise<void> {
    if (this.acceptsSend()) return;
    if (this.handoff || this.isBusyState()) throw new Error('会话正在处理中，请稍候');
    if (!this.launchContext) throw new Error('尚未创建会话，请先新建会话或继续最近会话');
    const prior = this.conversation();
    const sessionId = this.sessionId;
    const launch: ChatLaunch = sessionId ? { resumeSessionId: sessionId } : {};
    const context = this.launchContext;
    await this.releaseSettled();
    await this.start(context.lockKey, context.cliPath, context.cwd, launch, context.baseArgs, prior.length ? prior : undefined);
    if (!this.acceptsSend()) await this.waitUntilAccepting();
    if (!this.acceptsSend()) throw new Error(this.lastFailure || 'CLI 进程已退出。请再发送一次，或新建会话。');
  }

  /**
   * Forget a settled chat so a deleted index row cannot be written back.
   * The session id is cleared before the process is torn down.
   */
  async discardSettled(): Promise<void> {
    if (this.handoff || this.isBusyState()) throw new Error('A chat session is already active');
    this.sessionId = undefined;
    this.messages = [];
    this.launchContext = undefined;
    await this.releaseSettled();
    this.reset();
    this.setState('idle');
  }

  /** Drop a settled supervisor so a new chat or the native terminal can take the project lock. */
  async releaseSettled(): Promise<void> {
    if (this.handoff || this.isBusyState()) throw new Error('A chat session is already active');
    if (!this.supervisor && !this.blockingChild) return;
    if (this.supervisor) this.blockingChild = this.detachSupervisor();
    const child = this.blockingChild;
    if (!child) return;
    const exited = await this.terminateChild(child, true);
    if (this.blockingChild === child) this.blockingChild = undefined;
    if (!exited) throw new Error('上一个会话进程尚未退出，请稍后再试');
  }

  private waitUntilAccepting(timeoutMs = 20000): Promise<void> {
    if (this.acceptsSend()) return Promise.resolve();
    if (this.state === 'failed' || this.state === 'interrupted') {
      return Promise.reject(new Error(this.lastFailure || '会话未能就绪'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish: ReadyWaiter = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.readyWaiters = this.readyWaiters.filter(item => item !== finish);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error('等待 CLI 就绪超时，请再试一次')), timeoutMs);
      this.readyWaiters.push(finish);
      if (this.acceptsSend()) finish();
      else if (this.state === 'failed' || this.state === 'interrupted') finish(new Error(this.lastFailure || '会话未能就绪'));
    });
  }

  private isBusyState(): boolean {
    return this.state === 'starting' || this.state === 'generating' || this.state === 'waiting';
  }

  private spawnSupervisor(lockKey: string): ChildProcessWithoutNullStreams {
    const helper = path.join(this.root, 'dist/chat-helper.cjs');
    if (this.launchSupervisor) return this.launchSupervisor(this.lockScope, lockKey, helper);
    const exe = path.join(this.root, 'dist/native/NativeSupervisor.exe');
    return spawn(exe, [this.lockScope, lockKey, process.execPath, helper], {
      cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
  }

  /** Drop the live handle before the old process exits, so that exit cannot clear a newer session. */
  private detachSupervisor(): ChildProcessWithoutNullStreams {
    const child = this.supervisor;
    if (!child) throw new Error('No chat supervisor to release');
    this.supervisor = undefined;
    this.ownerToken = undefined;
    this.buffer = '';
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = undefined; }
    return child;
  }

  private terminateChild(child: ChildProcessWithoutNullStreams, immediate = false): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      let giveUp: NodeJS.Timeout | undefined;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        if (grace) clearTimeout(grace);
        if (giveUp) clearTimeout(giveUp);
        resolve(exited);
      };
      child.once('exit', () => finish(true));
      const requestStop = () => {
        try { this.writeSupervisor('stop\n', child); } catch { /* stdin already closed */ }
        try { child.kill(); } catch { /* already exited */ }
      };
      const force = immediate || this.cliGone;
      grace = setTimeout(requestStop, force ? 200 : 3000);
      giveUp = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        finish(child.exitCode !== null || child.signalCode !== null);
      }, force ? 4000 : 8000);
      grace.unref();
      giveUp.unref();
      if (!force) {
        try {
          this.writeSupervisor(JSON.stringify({ type: 'kill' }) + '\n', child);
        } catch { /* stdin already closed */ }
      } else {
        requestStop();
      }
      if (child.exitCode !== null || child.signalCode !== null) finish(true);
    });
  }

  private async finishHandoff(lockKey: string, cliPath: string, cwd: string, launch: ChatLaunch, cliArgs?: string[]): Promise<void> {
    try {
      const child = this.blockingChild;
      if (!child) throw new Error('A chat session is already active');
      const exited = await this.terminateChild(child);
      if (!exited) throw new Error('Previous chat session did not exit');
      if (this.blockingChild === child) this.blockingChild = undefined;
      // starting belongs to this handoff. A supervisor here would be a newer session.
      if (this.supervisor) throw new Error('A chat session is already active');
      this.launch(lockKey, cliPath, cwd, launch, cliArgs);
    } catch (error) {
      this.pendingMessages = undefined;
      if (!this.supervisor && this.isBusyState()) {
        const message = error instanceof Error ? error.message : 'Failed to start chat session';
        this.setState('failed', message);
      }
      throw error;
    } finally {
      this.handoff = false;
    }
  }

  private launch(lockKey: string, cliPath: string, cwd: string, launch: ChatLaunch, cliArgs?: string[]): void {
    const pending = this.pendingMessages;
    this.pendingMessages = undefined;
    this.reset();
    this.launchContext = { lockKey, cliPath, cwd, baseArgs: cliArgs ? [...cliArgs] : undefined };
    if (launch.resumeSessionId) {
      this.sessionId = launch.resumeSessionId;
      this.seededFromId = launch.resumeSessionId;
    }
    if (pending?.length) this.seed(pending);
    const token = randomUUID(); this.ownerToken = token;
    this.setState('starting');
    const args = cliArgsFor(launch, cliArgs);
    this.startPayload = { cwd, cliPath, args };
    const child = this.spawnSupervisor(lockKey);
    this.supervisor = child;
    this.lastActivityAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (['starting', 'generating', 'waiting'].includes(this.state) && Date.now() - this.lastActivityAt > this.noProgressTimeoutMs) {
        const seconds = Math.round(this.noProgressTimeoutMs / 1000);
        const message = `No response from CLI for ${seconds}s; the CLI may be waiting for authentication, a permission, or has failed to start.`;
        this.halt('failed', `No response from CLI for ${seconds}s`);
        this.emit({ type: 'error', message });
      }
    }, 5000).unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.ownerToken !== token) return;
      this.buffer += chunk;
      if (this.buffer.length > 1024 * 1024) { this.setState('failed', 'Supervisor message exceeds limit'); this.stop(); return; }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        let line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as HelperEvent;
          this.handleHelper(event);
        } catch { this.emit({ type: 'error', message: 'Invalid supervisor message' }); this.stop(); }
      }
    });
    child.stdin.on('error', () => { /* supervisor closed the pipe */ });
    child.stderr.on('data', () => this.emit({ type: 'error', message: 'Supervisor failed to start or assign process job' }));
    child.on('error', error => { if (this.ownerToken === token) this.setState('failed', error.message); });
    let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let stdoutEnded = false;
    let exitSettled = false;
    let exitFallback: NodeJS.Timeout | undefined;
    const finishSupervisorExit = (force = false) => {
      if (exitSettled || !exitStatus || (!stdoutEnded && !force)) return;
      exitSettled = true;
      if (exitFallback) { clearTimeout(exitFallback); exitFallback = undefined; }
      if (force && !stdoutEnded) {
        try { child.stdout.destroy(); } catch { /* stream already closed */ }
      }
      // A replaced session's exit must not clear the supervisor that replaced it.
      if (this.ownerToken !== token || this.supervisor !== child) return;
      this.supervisor = undefined; this.ownerToken = undefined;
      if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = undefined; }
      for (const stream of [child.stdin, child.stderr]) { try { stream.destroy(); } catch { /* already closed */ } }
      if (this.stopping) {
        if (this.state !== 'failed' && this.state !== 'interrupted') this.setState('interrupted', 'Stopped by user');
        return;
      }
      if (this.state !== 'idle' && this.state !== 'failed' && this.state !== 'interrupted' && this.state !== 'completed') {
        const message = describeCliExit(exitStatus.code, exitStatus.signal);
        this.setState('failed', message);
        this.emit({ type: 'error', message });
      }
    };
    const noteSupervisorExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!exitStatus) exitStatus = { code, signal };
      if (!stdoutEnded && !exitFallback) {
        // ChildProcess 'exit' can precede the last supervisor protocol bytes.
        // Wait for stdout to drain, but don't let an inherited pipe hang forever.
        exitFallback = setTimeout(() => finishSupervisorExit(true), 2000);
      }
      finishSupervisorExit(false);
    };
    child.stdout.on('end', () => {
      stdoutEnded = true;
      finishSupervisorExit(false);
    });
    child.stdout.on('close', () => {
      stdoutEnded = true;
      finishSupervisorExit(false);
    });
    child.on('exit', noteSupervisorExit);
    child.on('close', (code, signal) => {
      noteSupervisorExit(code, signal);
      stdoutEnded = true;
      finishSupervisorExit(false);
    });
  }

  private reset(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = undefined; }
    this.buffer = ''; this.sessionId = undefined; this.model = undefined; this.messages = [];
    this.currentId = undefined; this.blocks = []; this.toolInput = ''; this.turnStarted = false; this.stopping = false; this.turnCostUsd = undefined; this.syntheticTurn = false;
    this.seededFromId = undefined;
    this.cliGone = false;
    this.turnAccepted = false;
    this.lastFailure = undefined;
  }

  private nudgeSupervisorExit(): void {
    this.cliGone = true;
    const child = this.supervisor;
    if (!child || !child.stdin.writable) return;
    try { this.writeSupervisor('stop\n', child); } catch { /* supervisor already closed */ }
  }

  private handleHelper(event: HelperEvent): void {
    this.lastActivityAt = Date.now();
    if (event.type === 'busy') { this.setState('failed', 'This session is already in use'); this.emit({ type: 'error', message: 'This session is already in use' }); return; }
    if (event.type === 'ready') { if (this.startPayload) this.command({ type: 'start', ...this.startPayload }); return; }
    if (event.type === 'spawned') { if (this.state === 'starting') this.setState('completed'); return; }
    if (event.type === 'cli' && isPlainObject(event.data)) { this.handleCli(event.data as CliEvent); return; }
    if (event.type === 'stderr') { this.emit({ type: 'error', message: typeof event.text === 'string' ? event.text.slice(0, 500) : 'CLI stderr' }); return; }
    if (event.type === 'exit') { this.handleCliExit(event); return; }
    if (event.type === 'error') {
      const message = describeCliFailure(typeof event.message === 'string' ? event.message : 'CLI error');
      this.lastFailure = message;
      this.setState('failed', message);
      this.emit({ type: 'error', message });
    }
  }

  private handleCliExit(event: HelperEvent): void {
    const detail = typeof event.detail === 'string' ? event.detail : undefined;
    // Only an assistant bubble that is still open belongs to this exit.
    // A turn that already reached `result` has been committed and must not be rewritten.
    if (!this.turnAccepted && this.currentId) {
      const cleanExit = typeof event.code === 'number' && event.code === 0 && this.hasVisibleAssistant();
      this.commitOpenAssistant(cleanExit ? 'complete' : 'error');
      if (cleanExit) this.turnAccepted = true;
    }
    this.nudgeSupervisorExit();
    if (this.stopping) return;
    if (this.turnAccepted) {
      if (this.state !== 'completed') this.setState('completed');
      return;
    }
    if (this.state === 'failed' && this.lastFailure) return;
    const message = describeCliExit(event.code, event.signal, detail);
    this.lastFailure = message;
    this.setState('failed', message);
    this.emit({ type: 'error', message });
  }

  private noteSession(event: CliEvent): void {
    if (event.type === 'system' && event.subtype === 'init') return;
    const reported = typeof event.session_id === 'string' ? event.session_id : undefined;
    if (reported && !this.sessionId) this.sessionId = reported;
  }

  private handleCli(event: CliEvent): void {
    this.noteSession(event);
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          const reported = typeof event.session_id === 'string' ? event.session_id : undefined;
          if (reported && this.seededFromId && reported !== this.seededFromId) {
            // Do not file the restored transcript under a different native session id.
            this.messages = [];
            this.seededFromId = undefined;
            this.emit({ type: 'error', message: '', code: 'transcript-mismatch' });
          }
          if (reported) this.sessionId = reported;
          this.model = usableModel(event.model) ?? this.model;
          this.emit({ type: 'init', sessionId: this.sessionId ?? '', cwd: typeof event.cwd === 'string' ? event.cwd : '', model: this.model ?? '' });
          if (this.state === 'starting') this.setState('completed');
          this.emit({ type: 'transcript' });
        } else if (event.subtype === 'status' && this.state === 'generating') {
          this.setState('generating');
        }
        return;
      case 'assistant':
        if (isPlainObject(event.message)) this.applyAssistantMessage(event.message);
        else this.applyAssistantMessage(event);
        return;
      case 'stream_event': {
        const inner = (event.event ?? {}) as { type?: string; delta?: Record<string, unknown>; content_block?: Record<string, unknown>; message?: Record<string, unknown> };
        this.handleStream(inner);
        return;
      }
      case 'control_request': {
        this.setState('waiting', 'Waiting for permission');
        this.respondControl(event as unknown as Record<string, unknown>);
        return;
      }
      case 'result': {
        this.finishTurn(event);
        return;
      }
      default:
        return;
    }
  }

  private blocksFromContent(content: unknown): ChatBlock[] {
    if (typeof content === 'string' && content.length > 0) return [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return [];
    const blocks: ChatBlock[] = [];
    for (const part of content) {
      if (typeof part === 'string' && part.length > 0) {
        blocks.push({ type: 'text', text: part });
        continue;
      }
      if (!isPlainObject(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'tool_use') {
        const name = typeof part.name === 'string' && part.name ? part.name : 'tool';
        let input = '';
        if (typeof part.input === 'string') input = part.input;
        else if (part.input !== undefined) {
          try { input = JSON.stringify(part.input); } catch { input = ''; }
        }
        blocks.push({ type: 'tool_use', name, input });
      }
    }
    return blocks;
  }

  private streamedText(): string {
    return this.blocks.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('');
  }

  /** Full assistant messages are the canonical transcript. Stream deltas only fill what is missing. */
  private applyAssistantMessage(message: Record<string, unknown>): void {
    // A <synthetic> reply (API error, local notice) is not a model choice. It must never
    // replace the model the user picked, or the composer picker would show <synthetic>.
    const synthetic = isSyntheticModel(message.model);
    if (!synthetic) {
      const model = usableModel(message.model);
      if (model) this.model = model;
    }
    const parts = this.blocksFromContent(message.content);
    if (synthetic && parts.length > 0) this.syntheticTurn = true;
    if (parts.length === 0) return;
    this.turnStarted = true;
    this.beginAssistant();
    const text = parts.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('');
    const have = this.streamedText();
    // A later assistant message in a tool loop is new text, not a prefix of the first one.
    const addition = !text ? '' : (!have || text.startsWith(have)) ? text.slice(have.length) : (have.includes(text) ? '' : text);
    if (addition) {
      const last = this.blocks[this.blocks.length - 1];
      if (last && last.type === 'text' && text.startsWith(have)) last.text += addition;
      else this.blocks.push({ type: 'text', text: addition });
      if (this.currentId) this.emit({ type: 'text_delta', messageId: this.currentId, text: addition });
    }
    for (const part of parts) {
      if (part.type !== 'tool_use') continue;
      const same = this.blocks.find((block): block is { type: 'tool_use'; name: string; input: string } => block.type === 'tool_use' && block.name === part.name);
      if (same) {
        if (part.input.length >= same.input.length) same.input = part.input;
        continue;
      }
      this.blocks.push(part);
      if (this.currentId) this.emit({ type: 'tool_use', messageId: this.currentId, name: part.name, input: part.input });
    }
    this.syncLiveMessage();
    this.emit({ type: 'transcript' });
  }

  private handleStream(inner: { type?: string; delta?: Record<string, unknown>; content_block?: Record<string, unknown> }): void {
    const type = inner.type;
    if (type === 'message_start') {
      this.turnStarted = true;
      this.beginAssistant();
      return;
    }
    if (type === 'content_block_start' && inner.content_block) {
      const block = inner.content_block as { type?: string; name?: string; text?: string };
      if (block.type === 'text') { this.blocks.push({ type: 'text', text: '' }); }
      else if (block.type === 'thinking') { this.blocks.push({ type: 'thinking', thinking: '' }); }
      else if (block.type === 'tool_use') {
        this.blocks.push({ type: 'tool_use', name: typeof block.name === 'string' ? block.name : 'tool', input: '' });
        this.toolInput = '';
        if (this.currentId) this.emit({ type: 'tool_use', messageId: this.currentId, name: typeof block.name === 'string' ? block.name : 'tool', input: '' });
      }
      return;
    }
    if (type === 'content_block_delta' && inner.delta && this.currentId) {
      const delta = inner.delta as { type?: string; text?: string; thinking?: string; partial_json?: string };
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        const last = this.blocks[this.blocks.length - 1];
        if (last && last.type === 'text') last.text += delta.text; else this.blocks.push({ type: 'text', text: delta.text });
        this.emit({ type: 'text_delta', messageId: this.currentId, text: delta.text });
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        const last = this.blocks[this.blocks.length - 1];
        if (last && last.type === 'thinking') last.thinking += delta.thinking; else this.blocks.push({ type: 'thinking', thinking: delta.thinking });
        this.emit({ type: 'thinking_delta', messageId: this.currentId, text: delta.thinking });
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        this.toolInput += delta.partial_json;
        const last = this.blocks[this.blocks.length - 1];
        if (last && last.type === 'tool_use') last.input = this.toolInput;
      }
      return;
    }
    if (type === 'content_block_stop') { return; }
    if (type === 'message_stop' || type === 'message_delta') { return; }
  }

  private beginAssistant(): void {
    if (this.currentId) return;
    this.currentId = randomUUID();
    this.blocks = [];
    const message: ChatMessage = {
      id: this.currentId,
      role: 'assistant',
      blocks: [],
      state: 'streaming',
      model: this.syntheticTurn ? undefined : this.model,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    this.emit({ type: 'assistant_start', messageId: this.currentId, model: message.model });
  }

  /** Text and tool_use are the user-facing transcript. Thinking stays a live status, not a bubble. */
  private userFacingBlocks(fallbackText?: string): ChatBlock[] {
    const blocks: ChatBlock[] = [];
    for (const block of this.blocks) {
      if (block.type === 'thinking') continue;
      if (block.type === 'text') {
        if (!block.text) continue;
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        blocks.push({ type: 'tool_use', name: block.name, input: block.input });
      }
    }
    if (fallbackText && !blocks.some(block => block.type === 'text')) blocks.push({ type: 'text', text: fallbackText });
    return blocks;
  }

  private syncLiveMessage(): void {
    if (!this.currentId) return;
    const message = this.messages.find(item => item.id === this.currentId);
    if (!message) return;
    message.blocks = this.userFacingBlocks();
    message.model = this.syntheticTurn ? undefined : this.model;
  }

  private hasVisibleAssistant(): boolean {
    if (this.userFacingBlocks().length > 0) return true;
    const last = [...this.messages].reverse().find(item => item.role === 'assistant');
    return !!last && last.blocks.some(block => (block.type === 'text' && block.text.trim().length > 0) || block.type === 'tool_use');
  }

  private commitAssistant(state: ChatMessage['state'], fallbackText?: string): void {
    if (!this.currentId) return;
    const message = this.messages.find(item => item.id === this.currentId);
    if (message) {
      message.blocks = this.userFacingBlocks(fallbackText);
      message.state = state;
      message.model = this.syntheticTurn ? undefined : this.model;
    }
    const endState: 'complete' | 'interrupted' | 'error' = state === 'interrupted' ? 'interrupted' : state === 'error' ? 'error' : 'complete';
    this.emit({ type: 'assistant_end', messageId: this.currentId, state: endState });
    this.currentId = undefined;
    this.blocks = [];
    this.toolInput = '';
    this.turnStarted = false;
  }

  private commitOpenAssistant(state: ChatMessage['state']): void {
    if (!this.currentId) return;
    this.commitAssistant(state);
  }

  private resultText(event: CliEvent): string {
    if (typeof event.result === 'string') return event.result;
    return this.blocksFromContent(event.result).filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('');
  }

  private finishTurn(event: CliEvent): void {
    const result = this.resultText(event);
    const subtype = typeof event.subtype === 'string' ? event.subtype : '';
    // The CLI reports some API failures as a normal-looking <synthetic> reply.
    const syntheticError = this.syntheticTurn && (looksLikeApiError(result) || looksLikeApiError(this.streamedText()));
    const isError = event.is_error === true || (subtype !== 'success' && /error/i.test(subtype)) || syntheticError;
    this.turnCostUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined;
    const errorText = isError ? (result || this.streamedText() || this.lastAssistantText()) : '';
    if (!this.currentId) this.beginAssistant();
    const messageId = this.currentId ?? '';
    this.commitAssistant(isError ? 'error' : 'complete', result || undefined);
    this.turnAccepted = !isError;
    this.syntheticTurn = false;
    this.emit({ type: 'turn_complete', messageId, result: result || errorText, costUsd: this.turnCostUsd, isError });
    const failure = 'Claude CLI 报告本回合出错。可以重新发送，或新建会话后再试。';
    if (isError) this.lastFailure = failure;
    this.setState(isError ? 'failed' : 'completed', isError ? failure : undefined);
  }

  private lastAssistantText(): string {
    const last = [...this.messages].reverse().find(item => item.role === 'assistant');
    if (!last) return '';
    return last.blocks.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('');
  }

  private respondControl(event: Record<string, unknown>): void {
    const requestId = typeof event.request_id === 'string' ? event.request_id : undefined;
    const request = isPlainObject(event.request) ? (event.request as Record<string, unknown>) : undefined;
    const requestType = request ? (typeof request.type === 'string' ? request.type : 'can_use_tool') : 'can_use_tool';
    const toolName = request ? (typeof request.tool_name === 'string' ? request.tool_name : undefined) : undefined;
    this.emit({ type: 'state', state: 'waiting', message: `Permission request: ${requestType}${toolName ? ` (${toolName})` : ''}` });
    // Answer the native permission request as the host; the CLI still performs its own
    // permission evaluation. The app defaults to allowing read-only tool use.
    const allowed = this.isReadOnlyTool(requestType, toolName);
    const response = {
      subtype: 'success',
      request_id: requestId ?? '',
      response: { behavior: allowed ? 'allow' : 'deny', updatedInput: {}, permissionDecision: allowed ? 'allow' : 'deny' }
    };
    this.command({ type: 'control', response });
    this.setState('generating');
  }

  private isReadOnlyTool(requestType: string, toolName?: string): boolean {
    if (requestType !== 'can_use_tool') return true;
    if (!toolName) return true;
    return /^(Read|Glob|Grep|WebSearch|WebFetch|Skill|Task|ListAgents|SendMessage|CronList|Monitor|NotebookEdit)$/i.test(toolName);
  }

  send(text: string): void {
    if (typeof text !== 'string' || text.length === 0 || text.length > 262144) throw new Error('Invalid message');
    if (this.handoff) throw new Error('会话正在处理中，请稍候');
    if (this.state === 'idle') throw new Error('尚未创建会话，请先新建会话或继续最近会话');
    if (this.state === 'failed' || this.state === 'interrupted') throw new Error('会话已结束，请新建会话或继续最近会话');
    if (this.state !== 'completed') throw new Error('会话正在处理中，请稍候');
    if (!this.supervisor?.stdin.writable) {
      throw new Error('CLI 进程已退出。请再发送一次，或新建会话。');
    }
    const userMessage: ChatMessage = { id: randomUUID(), role: 'user', blocks: [{ type: 'text', text }], state: 'complete', createdAt: new Date().toISOString() };
    this.messages.push(userMessage);
    this.emit({ type: 'user_message', message: { ...userMessage, blocks: userMessage.blocks.map(b => ({ ...b })) } });
    this.turnAccepted = false;
    this.turnStarted = false;
    this.syntheticTurn = false;
    this.setState('generating');
    this.command({ type: 'user', message: text });
  }

  stop(): void {
    this.halt('interrupted', 'Stopped by user');
  }

  /** End the supervisor without letting a later exit event rewrite a terminal state. */
  private halt(finalState: 'interrupted' | 'failed', message: string): void {
    if (!this.supervisor || this.stopping) return;
    this.stopping = true;
    if (this.currentId) this.commitAssistant(finalState === 'failed' ? 'error' : 'interrupted');
    this.setState(finalState, message);
    const child = this.supervisor;
    this.command({ type: 'kill' });
    setTimeout(() => { if (this.supervisor === child) this.writeSupervisor('stop\n', child); }, 3000).unref();
  }
}
