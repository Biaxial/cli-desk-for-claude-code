import { ChatLaunch, ChatMessage, SessionRecord } from './contracts';

/** Flags used for a fresh graphical session when the caller does not supply argv. */
export const DEFAULT_CHAT_CLI_ARGS = [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
];

export type ResolvedChatLaunch = {
  resumeSessionId?: string;
  continueLatest?: boolean;
};

/** Session ids are passed to the CLI as a single argv element. Reject flag-like values. */
export function assertSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) throw new Error('Invalid session id');
}

/**
 * History restore and "continue latest" both prefer a verified index id plus `--resume`.
 * `--continue` is only the fallback when this project has no indexed session.
 * This function does not invent ids; it only returns one already stored on a record.
 */
export function resolveChatLaunch(launch: ChatLaunch, records: SessionRecord[], projectId: string): ResolvedChatLaunch {
  if (launch.resumeSessionId) {
    assertSafeSessionId(launch.resumeSessionId);
    return { resumeSessionId: launch.resumeSessionId };
  }
  if (launch.continueLatest) {
    const latest = records
      .filter(record => record.projectId === projectId && record.sessionId.length > 0)
      .sort((a, b) => {
        if (a.lastActiveAt !== b.lastActiveAt) return a.lastActiveAt < b.lastActiveAt ? 1 : -1;
        return a.sessionId < b.sessionId ? 1 : -1;
      })[0];
    if (latest) {
      assertSafeSessionId(latest.sessionId);
      return { resumeSessionId: latest.sessionId };
    }
    return { continueLatest: true };
  }
  return {};
}

export function sessionBelongsToProject(records: SessionRecord[], projectId: string, sessionId: string): boolean {
  return records.some(record => record.projectId === projectId && record.sessionId === sessionId);
}

/**
 * Claude CLI slash command for the model already selected in the session.
 * Sent through the same chat stdin path as a user message. No separate model API.
 * A blank name asks the CLI to report the current model (`/model`).
 */
export function modelSlashCommand(name?: string): string {
  const trimmed = (name ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return '/model';
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) throw new Error('模型名称无效');
  if (trimmed === '/model' || trimmed.startsWith('/model ')) return trimmed;
  return `/model ${trimmed}`;
}

export function cliArgsFor(launch: ChatLaunch, base?: string[]): string[] {
  const args = [...(base ?? DEFAULT_CHAT_CLI_ARGS)];
  if (launch.resumeSessionId) {
    const withoutContinue = args.filter(arg => arg !== '--continue');
    if (!withoutContinue.includes('--resume')) withoutContinue.push('--resume', launch.resumeSessionId);
    return withoutContinue;
  }
  if (launch.continueLatest && !args.includes('--continue')) args.push('--continue');
  return args;
}

function visibleText(message?: ChatMessage): string {
  if (!message) return '';
  const text = message.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text;
  const tool = message.blocks.find((block): block is { type: 'tool_use'; name: string; input: string } => block.type === 'tool_use');
  if (tool?.name) return `工具 ${tool.name}`;
  return '';
}

/** Title comes from the first user turn. A renamed title is kept. Preview prefers the latest assistant text. */
export function summarizeConversation(
  messages: ChatMessage[],
  existing?: { title?: string; preview?: string; titleEdited?: boolean }
): { title: string; preview: string; messageCount: number } {
  const firstUser = messages.find(message => message.role === 'user');
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const autoTitle = visibleText(firstUser) || existing?.title || '新会话';
  const title = existing?.titleEdited && existing.title ? existing.title : autoTitle;
  const preview = visibleText(lastAssistant) || visibleText(firstUser) || existing?.preview || '';
  return {
    title: title.slice(0, 80),
    preview: preview.slice(0, 200),
    messageCount: messages.length,
  };
}

/** Header and sidebar title. Same rules as the saved summary. */
export function sessionTitleFromMessages(
  messages: ChatMessage[],
  existing?: { title?: string; preview?: string; titleEdited?: boolean }
): string {
  return summarizeConversation(messages, existing).title;
}

/**
 * What the chat screen should show after a launch.
 * New sessions clear the thread. Continue and restore keep the seeded transcript.
 */
export function transcriptAfterLaunch(
  kind: 'new' | 'continue' | 'resume',
  result: { sessionId?: string; messages?: ChatMessage[] }
): { sessionId?: string; messages: ChatMessage[] } {
  if (kind === 'new') return { sessionId: undefined, messages: [] };
  const messages = Array.isArray(result.messages)
    ? result.messages.map(message => ({ ...message, blocks: message.blocks.map(block => ({ ...block })) }))
    : [];
  return { sessionId: result.sessionId, messages };
}
