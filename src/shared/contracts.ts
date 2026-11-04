import type { ErrorHint } from './error-hints';
import type { Locale, TranslationKey } from './i18n';

export type Project = { id: string; name: string; directory: string; lastOpenedAt: string };
export type Settings = { schemaVersion: 1; cliPath: string | null; projects: Project[]; activeProjectId: string | null; language: Locale };
export type SessionState = 'idle' | 'starting' | 'active' | 'stopping' | 'exited' | 'failed' | 'busy';
export type TerminalEvent =
  | { type: 'status'; state: SessionState; message?: string }
  | { type: 'data'; data: string }
  | { type: 'started'; pid: number; cols: number; rows: number }
  | { type: 'exit'; exitCode: number; signal?: number }
  | { type: 'error'; message: string }
  | { type: 'ready' | 'busy' | 'stopped'; detail: string };
export type HelperCommand = { type: 'start'; cliPath: string; cwd: string; cols: number; rows: number } | { type: 'write'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'kill' };
export function clampDimension(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value)) throw new Error('Invalid terminal dimension');
  return Math.min(max, Math.max(min, value as number));
}
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- M02 graphical chat ---
export type ChatState = 'idle' | 'starting' | 'generating' | 'waiting' | 'completed' | 'interrupted' | 'failed';

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; name: string; input: string };

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  state: 'streaming' | 'complete' | 'interrupted' | 'error';
  model?: string;
  createdAt: string;
};

export type ChatEvent =
  | { type: 'state'; state: ChatState; message?: string }
  | { type: 'init'; sessionId: string; cwd: string; model: string }
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'assistant_start'; messageId: string; model?: string }
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'thinking_delta'; messageId: string; text: string }
  | { type: 'tool_use'; messageId: string; name: string; input: string }
  | { type: 'assistant_end'; messageId: string; state: 'complete' | 'interrupted' | 'error' }
  | { type: 'turn_complete'; messageId: string; result: string; costUsd?: number; isError: boolean }
  | { type: 'transcript' }
  | { type: 'error'; message: string; code?: 'transcript-mismatch' }
  /** Classified failure with Chinese wording and a next step. Sent once per failed turn. */
  | { type: 'error_hint'; hint: ErrorHint; messageId?: string };

export type SessionRecord = {
  sessionId: string;
  projectId: string;
  projectDirectory: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
  /** When true, sync keeps this title instead of replacing it from the first question. */
  titleEdited?: boolean;
};

export type ChatLaunch = { resumeSessionId?: string; continueLatest?: boolean };

export type ChatStartResult = {
  state: ChatState;
  sessionId?: string;
  messages: ChatMessage[];
};

export type ChatReadiness = {
  configured: boolean;
  missing: 'project' | 'cli' | null;
  hasProject: boolean;
  hasCli: boolean;
  sessionState: ChatState;
  sessionId?: string;
};

export type HealthStatus = 'ok' | 'warn' | 'error';
export type HealthCheckRow = {
  id: 'cli' | 'version' | 'settings' | 'proxy';
  status: HealthStatus;
  labelCode: TranslationKey;
  detailCode: TranslationKey;
  detailParams?: Record<string, string | number>;
  fixCode?: TranslationKey;
  fixParams?: Record<string, string | number>;
};
export type HealthCheckResult = {
  status: HealthStatus;
  rows: HealthCheckRow[];
  cliPath?: string;
  checkedAt: string;
};
