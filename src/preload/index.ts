import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ChatEvent, ChatMessage, ChatLaunch, ChatReadiness, ChatStartResult, HealthCheckResult, Settings, SessionRecord, TerminalEvent } from '../shared/contracts';
import type { Locale } from '../shared/i18n';
import type { CatalogModel } from '../shared/model-catalog';
import type { AttachmentMetadata } from '../shared/attachments';

type AttachmentInspection = { attachments: AttachmentMetadata[]; rejected: number; omitted: number };

contextBridge.exposeInMainWorld('ccDesktop', Object.freeze({
  projects: () => ipcRenderer.invoke('projects:list') as Promise<Settings>,
  addProject: () => ipcRenderer.invoke('projects:add') as Promise<Settings>,
  activateProject: (id: string) => ipcRenderer.invoke('projects:activate', id) as Promise<Settings>,
  removeProject: (id: string) => ipcRenderer.invoke('projects:remove', id) as Promise<Settings>,
  selectCli: () => ipcRenderer.invoke('cli:select') as Promise<Settings>,
  setLanguage: (language: Locale) => ipcRenderer.invoke('settings:setLanguage', language) as Promise<Settings>,
  start: (cols: number, rows: number) => ipcRenderer.invoke('terminal:start', cols, rows) as Promise<{ state: string }>,
  stop: () => ipcRenderer.invoke('terminal:stop') as Promise<{ state: string }>,
  write: (data: string) => ipcRenderer.send('terminal:write', data),
  resize: (cols: number, rows: number) => ipcRenderer.send('terminal:resize', cols, rows),
  copy: (text: string) => ipcRenderer.send('terminal:copy', text),
  onTerminal: (listener: (event: TerminalEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TerminalEvent) => listener(data);
    ipcRenderer.on('terminal:event', handler);
    return () => ipcRenderer.removeListener('terminal:event', handler);
  },
  chatStart: (launch: ChatLaunch) => ipcRenderer.invoke('chat:start', launch) as Promise<ChatStartResult>,
  chatSend: (input: string | { text: string; attachmentPaths: string[] }) => ipcRenderer.invoke('chat:send', input) as Promise<{ state: string }>,
  selectAttachments: () => ipcRenderer.invoke('attachments:select') as Promise<AttachmentInspection>,
  inspectAttachments: (paths: string[]) => ipcRenderer.invoke('attachments:inspect', paths) as Promise<AttachmentInspection>,
  chatStop: () => ipcRenderer.invoke('chat:stop') as Promise<{ state: string }>,
  chatStatus: () => ipcRenderer.invoke('chat:status') as Promise<{ state: string; sessionId?: string }>,
  chatReadiness: () => ipcRenderer.invoke('chat:readiness') as Promise<ChatReadiness>,
  healthCheck: () => ipcRenderer.invoke('health:check') as Promise<HealthCheckResult>,
  chatList: () => ipcRenderer.invoke('chat:list') as Promise<SessionRecord[]>,
  chatRename: (sessionId: string, title: string) => ipcRenderer.invoke('chat:rename', sessionId, title) as Promise<SessionRecord | undefined>,
  chatSetPinned: (sessionId: string, pinned: boolean) => ipcRenderer.invoke('chat:setPinned', sessionId, pinned) as Promise<SessionRecord>,
  chatMove: (sessionId: string, projectId: string) => ipcRenderer.invoke('chat:move', sessionId, projectId) as Promise<SessionRecord>,
  chatDelete: (sessionId: string) => ipcRenderer.invoke('chat:delete', sessionId) as Promise<{ removed: boolean }>,
  models: (force?: boolean) => ipcRenderer.invoke('models:list', force === true) as Promise<{ models: CatalogModel[]; fromCache: boolean; error?: string }>,
  chatMessages: (sessionId: string) => ipcRenderer.invoke('chat:messages', sessionId) as Promise<ChatMessage[]>,
  pathForFile: (file: File) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  onChat: (listener: (event: ChatEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ChatEvent) => listener(data);
    ipcRenderer.on('chat:event', handler);
    return () => ipcRenderer.removeListener('chat:event', handler);
  }
}));
