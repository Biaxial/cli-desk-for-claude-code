import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ChatMessage, SessionRecord, isPlainObject } from '../../shared/contracts';

function isSessionRecord(value: unknown): value is SessionRecord {
  return isPlainObject(value) && typeof value.sessionId === 'string' && typeof value.projectId === 'string' &&
    typeof value.projectDirectory === 'string' && typeof value.title === 'string' && typeof value.preview === 'string' &&
    typeof value.messageCount === 'number' && typeof value.createdAt === 'string' && typeof value.lastActiveAt === 'string' &&
    (value.titleEdited === undefined || typeof value.titleEdited === 'boolean');
}
function isChatMessage(value: unknown): value is ChatMessage {
  return isPlainObject(value) && typeof value.id === 'string' && (value.role === 'user' || value.role === 'assistant') &&
    Array.isArray(value.blocks) && typeof value.state === 'string' && typeof value.createdAt === 'string';
}

export class SessionRepository {
  private readonly filename: string;
  private readonly messagesDir: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.filename = path.join(root, 'sessions.json');
    this.messagesDir = path.join(root, 'sessions');
    mkdirSync(this.messagesDir, { recursive: true });
  }
  private load(): SessionRecord[] {
    if (!existsSync(this.filename)) return [];
    const data: unknown = JSON.parse(readFileSync(this.filename, 'utf8'));
    if (!isPlainObject(data) || !Array.isArray(data.sessions) || !data.sessions.every(isSessionRecord)) {
      throw new Error('Application sessions are invalid; original file was not overwritten');
    }
    return data.sessions as SessionRecord[];
  }
  private save(records: SessionRecord[]): void {
    const temporary = this.filename + '.' + Math.random().toString(36).slice(2) + '.tmp';
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, sessions: records }, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, this.filename);
  }
  list(): SessionRecord[] {
    return this.load().sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }
  get(sessionId: string): SessionRecord | undefined {
    return this.load().find(item => item.sessionId === sessionId);
  }
  upsert(record: SessionRecord): void {
    const records = this.load();
    const index = records.findIndex(item => item.sessionId === record.sessionId);
    if (index >= 0) records[index] = record; else records.push(record);
    this.save(records);
  }
  touch(sessionId: string, patch: Partial<Pick<SessionRecord, 'title' | 'preview' | 'messageCount' | 'lastActiveAt' | 'titleEdited'>>): void {
    const records = this.load();
    const record = records.find(item => item.sessionId === sessionId);
    if (!record) return;
    Object.assign(record, patch);
    this.save(records);
  }
  messagesPath(sessionId: string): string {
    return path.join(this.messagesDir, `${sessionId.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
  }
  saveMessages(sessionId: string, messages: ChatMessage[]): void {
    const temporary = this.messagesPath(sessionId) + '.' + Math.random().toString(36).slice(2) + '.tmp';
    writeFileSync(temporary, JSON.stringify(messages, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, this.messagesPath(sessionId));
  }
  loadMessages(sessionId: string): ChatMessage[] {
    const file = this.messagesPath(sessionId);
    if (!existsSync(file)) return [];
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(data) || !data.every(isChatMessage)) throw new Error('Session messages are invalid');
    return data as ChatMessage[];
  }
}
