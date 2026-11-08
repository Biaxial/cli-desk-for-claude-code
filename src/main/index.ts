import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { ProjectRepository } from './persistence/project-repository';
import { SessionRepository } from './persistence/session-repository';
import { validateCliPath, CliValidationError, CliDiagnostic } from './cli/validate-cli';
import { SessionCoordinator } from './sessions/session-coordinator';
import { ChatSessionCoordinator } from './chat/chat-session';
import { ChatEvent, ChatLaunch, ChatMessage, ChatStartResult, SessionRecord, clampDimension, isPlainObject } from '../shared/contracts';
import { resolveChatLaunch, sessionBelongsToProject, summarizeConversation } from '../shared/resume-plan';
import { probeModels } from './cli/probe-models';
import { CatalogModel } from '../shared/model-catalog';
import { shouldBlockNavigation } from '../shared/dropped-paths';
import { classifyCliError } from '../shared/error-hints';
import { errorContext } from './cli/claude-settings';
import { checkEnvironment } from './cli/health-check';
import { AttachmentMetadata, MAX_ATTACHMENTS, buildPromptWithAttachments, categorizeAttachmentExtension, dedupePaths, isAbsoluteAttachmentPath, unsupportedAttachmentTooltipCode } from '../shared/attachments';
import { buildDocxPromptSection, DocxExtractionError, extractDocxText, MAX_DOCX_TEXT_CHARACTERS } from './attachments/docx-extract';
import { isLocale, systemLocaleToLocale, t } from '../shared/i18n';
import { PRODUCT_NAME } from '../shared/brand';
import { resolveUserDataLocation } from './persistence/user-data-location';

app.setName(PRODUCT_NAME);

let window: BrowserWindow | undefined;
let projects: ProjectRepository;
let sessions: SessionRepository;
let session: SessionCoordinator;
let chat: ChatSessionCoordinator;
let chatProject: { id: string; directory: string } | undefined;
const root = path.resolve(__dirname, '..');
const userDataLocation = resolveUserDataLocation({
  env: process.env,
  appDataDir: app.getPath('appData'),
  sourceRoot: root,
  existsSync,
});
if (userDataLocation.source === 'env' || userDataLocation.source === 'env-legacy') mkdirSync(userDataLocation.path, { recursive: true });
app.setPath('userData', userDataLocation.path);

function sendChatEvent(event: ChatEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send('chat:event', event);
}

/** The coordinator's own wording after an is_error result; the result text is the useful part. */
const GENERIC_TURN_FAILURE = /Claude CLI 报告本回合出错/;
let hintedThisTurn = false;

/** One classified hint per failed turn. Reads only the base URL from Claude settings, never a token. */
async function publishErrorHint(text: string, messageId?: string): Promise<void> {
  if (hintedThisTurn || !text?.trim()) return;
  hintedThisTurn = true;
  let context = {};
  try { context = await errorContext(); } catch { context = {}; }
  sendChatEvent({ type: 'error_hint', hint: classifyCliError(text, context), messageId });
}

function isBusy(): boolean {
  return session.isRunning() || chat.isBusy();
}

function appLocale() { return projects.snapshot().language; }

function validateConfiguredCliPath(cliPath: string): string {
  try { return validateCliPath(cliPath); }
  catch (error) {
    if (error instanceof CliValidationError) throw new Error(t(error.code, error.params, appLocale()));
    throw error;
  }
}

function syncChatPersistence(): void {
  const sessionId = chat.sessionIdValue();
  if (!sessionId || !chatProject) return;
  const conversation = chat.conversation();
  const existing = sessions.get(sessionId);
  if (conversation.length === 0) {
    if (existing) sessions.touch(sessionId, { lastActiveAt: new Date().toISOString() });
    return;
  }
  const summary = summarizeConversation(conversation, existing);
  const record: SessionRecord = {
    sessionId,
    projectId: chatProject.id,
    projectDirectory: chatProject.directory,
    title: summary.title,
    preview: summary.preview,
    messageCount: summary.messageCount,
    titleEdited: existing?.titleEdited === true,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
  if (existing?.pinned === true) {
    record.pinned = true;
    if (existing.pinnedAt) record.pinnedAt = existing.pinnedAt;
  }
  sessions.upsert(record);
  sessions.saveMessages(sessionId, conversation);
}

app.whenReady().then(() => {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, 'app.log'), JSON.stringify({ time: new Date().toISOString(), event: 'user-data-location', source: userDataLocation.source }) + '\n', { encoding: 'utf8' });
  } catch { /* startup logging must never prevent the app from opening */ }
  let systemLocale: unknown;
  let preferredLanguages: unknown;
  try { systemLocale = app.getLocale(); } catch { /* locale detection can fail during startup */ }
  try { preferredLanguages = app.getPreferredSystemLanguages(); } catch { /* use the other locale hint when available */ }
  projects = new ProjectRepository(app.getPath('userData'), systemLocaleToLocale(systemLocale, preferredLanguages));
  sessions = new SessionRepository(app.getPath('userData'));
  session = new SessionCoordinator(root, app.getPath('userData'), event => {
    if (window && !window.isDestroyed()) window.webContents.send('terminal:event', event);
  });
  chat = new ChatSessionCoordinator(root, app.getPath('userData'), (event: ChatEvent) => {
    sendChatEvent(event);
    if (event.type === 'init' || event.type === 'user_message' || event.type === 'turn_complete' || event.type === 'assistant_end' || event.type === 'transcript') syncChatPersistence();
    if (event.type === 'user_message') hintedThisTurn = false;
    if (event.type === 'turn_complete' && event.isError) void publishErrorHint(event.result, event.messageId);
    else if (event.type === 'state' && event.state === 'failed' && event.message && !GENERIC_TURN_FAILURE.test(event.message)) void publishErrorHint(event.message);
  });
  const appIcon = path.join(__dirname, 'resources/icons/claude-mark.png');
  window = new BrowserWindow({
    width: 1180, height: 780, minWidth: 860, minHeight: 520,
    title: PRODUCT_NAME,
    icon: existsSync(appIcon) ? appIcon : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  window.setMenuBarVisibility(false);
  // A file drop must not navigate this window or open a second one. Chromium's
  // default is to load the dropped file, which replaces the app and leaves it stuck.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (shouldBlockNavigation(window?.webContents.getURL() ?? '', url)) event.preventDefault();
  });
  window.loadFile(path.join(__dirname, 'renderer/index.html'));
  window.on('closed', () => { window = undefined; session.stop(); chat.stop(); });
});
app.on('before-quit', () => { session?.stop(); chat?.stop(); });

function fromWindow(sender: Electron.WebContents): void {
  if (sender !== window?.webContents) throw new Error('Untrusted window');
}
function currentProject(): { id: string; name: string; directory: string } {
  const settings = projects.snapshot();
  const project = settings.projects.find(item => item.id === settings.activeProjectId);
  if (!project || !existsSync(project.directory) || !statSync(project.directory).isDirectory()) throw new Error(t('ipc.selectProject', {}, settings.language));
  if (!settings.cliPath) throw new Error(t('ipc.selectCli', {}, settings.language));
  return { id: project.id, name: project.name, directory: project.directory };
}
function chatReadiness(): { configured: boolean; missing: 'project' | 'cli' | null; hasProject: boolean; hasCli: boolean; sessionState: string; sessionId?: string } {
  const settings = projects.snapshot();
  const project = settings.projects.find(item => item.id === settings.activeProjectId);
  const hasProject = !!project && existsSync(project.directory) && statSync(project.directory).isDirectory();
  const hasCli = !!settings.cliPath;
  const missing: 'project' | 'cli' | null = !hasProject ? 'project' : (!hasCli ? 'cli' : null);
  return { configured: !missing, missing, hasProject, hasCli, sessionState: chat.status(), sessionId: chat.sessionIdValue() };
}
function logCliDiagnostic(diagnostic: CliDiagnostic): void {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, 'cli-validation.log'), JSON.stringify({ time: new Date().toISOString(), ...diagnostic }) + '\n', { encoding: 'utf8' });
  } catch { /* logging must never break validation */ }
}

type AttachmentInspection = { attachments: AttachmentMetadata[]; rejected: number; omitted: number };

/** Only paths received through a file drop or native chooser are surfaced to the renderer. */
async function inspectAttachmentPaths(value: unknown, extractDocx = true): Promise<AttachmentInspection> {
  const locale = appLocale();
  if (!Array.isArray(value)) throw new Error(t('ipc.invalidAttachments', {}, locale));
  let rejected = 0;
  const absolutePaths: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const filePath = item.trim();
    if (!isAbsoluteAttachmentPath(filePath)) {
      rejected += 1;
      continue;
    }
    absolutePaths.push(filePath);
  }
  const uniquePaths = dedupePaths(absolutePaths);
  const omitted = Math.max(0, uniquePaths.length - MAX_ATTACHMENTS);
  const attachments: AttachmentMetadata[] = [];
  for (const filePath of uniquePaths.slice(0, MAX_ATTACHMENTS)) {
    try {
      const info = statSync(filePath);
      if (!info.isFile()) {
        rejected += 1;
        continue;
      }
      const pathApi = /^[a-zA-Z]:[\\/]|^\\\\/.test(filePath) ? path.win32 : path;
      const extension = pathApi.extname(filePath).toLowerCase();
      const attachment: AttachmentMetadata = {
        path: filePath,
        name: pathApi.basename(filePath),
        extension,
        category: categorizeAttachmentExtension(extension),
        size: info.size,
        unsupported: !!unsupportedAttachmentTooltipCode(extension),
        tooltipCode: unsupportedAttachmentTooltipCode(extension)
      };
      if (extension === '.docx' && extractDocx) {
        try {
          const extracted = await extractDocxText(filePath, { locale });
          attachment.extractionStatus = 'extracted';
          attachment.extractedCharacters = Math.min(extracted.length, MAX_DOCX_TEXT_CHARACTERS);
        } catch (error) {
          attachment.extractionStatus = 'error';
          attachment.unsupported = true;
          attachment.tooltipCode = error instanceof DocxExtractionError ? `docx.${error.code}` as const : 'docx.corrupt';
          attachment.tooltipParams = error instanceof DocxExtractionError ? error.params : {};
        }
      }
      attachments.push(attachment);
    } catch {
      rejected += 1;
    }
  }
  return { attachments, rejected, omitted };
}

ipcMain.handle('projects:list', event => { fromWindow(event.sender); return projects.snapshot(); });
ipcMain.handle('settings:setLanguage', (event, language: unknown) => {
  fromWindow(event.sender);
  if (!isLocale(language)) throw new Error(t('ipc.invalidLanguage', {}, appLocale()));
  return projects.setLanguage(language);
});
ipcMain.handle('projects:add', async event => {
  fromWindow(event.sender);
  if (isBusy()) throw new Error(t('ipc.stopBeforeProjects', {}, appLocale()));
  const result = await dialog.showOpenDialog(window!, { title: t('dialog.projectTitle', {}, appLocale()), properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return projects.snapshot();
  return projects.add(result.filePaths[0]);
});
ipcMain.handle('projects:activate', (event, id: unknown) => {
  fromWindow(event.sender);
  if (typeof id !== 'string' || isBusy()) throw new Error(t('ipc.stopBeforeProjects', {}, appLocale()));
  return projects.activate(id);
});
ipcMain.handle('projects:remove', (event, id: unknown) => {
  fromWindow(event.sender);
  if (typeof id !== 'string' || isBusy()) throw new Error(t('ipc.stopBeforeProjects', {}, appLocale()));
  return projects.remove(id);
});
ipcMain.handle('cli:select', async event => {
  fromWindow(event.sender);
  const selection = await dialog.showOpenDialog(window!, { title: t('dialog.cliTitle', {}, appLocale()), properties: ['openFile'], filters: [{ name: t('dialog.cliFilter', {}, appLocale()), extensions: ['exe', 'cmd'] }] });
  if (selection.canceled || !selection.filePaths[0]) return projects.snapshot();
  try {
    return projects.setCliPath(validateCliPath(selection.filePaths[0]));
  } catch (error) {
    if (error instanceof CliValidationError) {
      logCliDiagnostic(error.diagnostic);
      throw new Error(t(error.code, error.params, appLocale()));
    }
    throw error;
  }
});
ipcMain.handle('attachments:select', async event => {
  fromWindow(event.sender);
  const selection = await dialog.showOpenDialog(window!, { title: t('dialog.attachmentsTitle', {}, appLocale()), properties: ['openFile', 'multiSelections'] });
  if (selection.canceled) return { attachments: [], rejected: 0, omitted: 0 } satisfies AttachmentInspection;
  return inspectAttachmentPaths(selection.filePaths);
});
ipcMain.handle('attachments:inspect', (event, paths: unknown) => {
  fromWindow(event.sender);
  return inspectAttachmentPaths(paths);
});
ipcMain.handle('terminal:start', async (event, cols: unknown, rows: unknown) => {
  fromWindow(event.sender);
  if (isBusy()) throw new Error(t('ipc.stopBeforeTerminal', {}, appLocale()));
  // A finished or failed chat must not keep the project mutex, or the native CLI looks "already active".
  await chat.releaseSettled();
  const project = currentProject();
  const cliPath = validateConfiguredCliPath(projects.snapshot().cliPath!);
  session.start(project.id, cliPath, project.directory, clampDimension(cols, 20, 400), clampDimension(rows, 5, 200));
  return { state: session.status() };
});
ipcMain.handle('terminal:stop', event => { fromWindow(event.sender); session.stop(); return { state: session.status() }; });
ipcMain.on('terminal:write', (event, data: unknown) => {
  if (event.sender === window?.webContents && typeof data === 'string' && data.length <= 65536) session.write(data);
});
ipcMain.on('terminal:resize', (event, cols: unknown, rows: unknown) => {
  if (event.sender !== window?.webContents) return;
  try { session.resize(clampDimension(cols, 20, 400), clampDimension(rows, 5, 200)); } catch { /* invalid dimensions ignored */ }
});
ipcMain.on('terminal:copy', (event, text: unknown) => {
  if (event.sender === window?.webContents && typeof text === 'string' && text.length <= 262144) clipboard.writeText(text);
});

ipcMain.handle('chat:start', async (event, launch: unknown): Promise<ChatStartResult> => {
  fromWindow(event.sender);
  if (isBusy()) throw new Error(t('ipc.stopBeforeChat', {}, appLocale()));
  const project = currentProject();
  const cliPath = validateConfiguredCliPath(projects.snapshot().cliPath!);
  const parsed: ChatLaunch = isPlainObject(launch) ? {
    resumeSessionId: typeof launch.resumeSessionId === 'string' && launch.resumeSessionId.length > 0 ? launch.resumeSessionId : undefined,
    continueLatest: launch.continueLatest === true
  } : {};
  const indexed = sessions.list();
  const resolved = resolveChatLaunch(parsed, indexed, project.id);
  if (resolved.resumeSessionId && !sessionBelongsToProject(indexed, project.id, resolved.resumeSessionId)) {
    throw new Error(t('ipc.invalidResumeProject', {}, appLocale()));
  }
  const initial = resolved.resumeSessionId ? sessions.loadMessages(resolved.resumeSessionId) : undefined;
  chatProject = { id: project.id, directory: project.directory };
  hintedThisTurn = false;
  await chat.start(project.id, cliPath, project.directory, resolved, undefined, initial);
  return { state: chat.status(), sessionId: chat.sessionIdValue(), messages: chat.conversation() };
});
ipcMain.handle('chat:send', async (event, input: unknown) => {
  fromWindow(event.sender);
  let text: string;
  let attachmentPaths: unknown[] = [];
  if (typeof input === 'string') {
    text = input;
  } else if (isPlainObject(input) && typeof input.text === 'string' && Array.isArray(input.attachmentPaths)) {
    text = input.text;
    attachmentPaths = input.attachmentPaths;
  } else {
    throw new Error(t('ipc.invalidMessage', {}, appLocale()));
  }
  if (attachmentPaths.length > 0) {
    // The attachment was already inspected when selected. Revalidate its path,
    // then extract below so send-time failures can be reported inside the block.
    const checked = await inspectAttachmentPaths(attachmentPaths, false);
    if (checked.rejected > 0) throw new Error(t('ipc.rejectedAttachments', { count: checked.rejected }, appLocale()));
    if (checked.omitted > 0) throw new Error(t('ipc.omittedAttachments', { maxCount: MAX_ATTACHMENTS }, appLocale()));
    const locale = appLocale();
    text = buildPromptWithAttachments(text, checked.attachments, locale);
    const docxSection = await buildDocxPromptSection(
      checked.attachments.filter(attachment => attachment.extension === '.docx'),
      (attachment, maxCharacters) => extractDocxText(attachment.path, { maxCharacters, locale }),
      MAX_DOCX_TEXT_CHARACTERS,
      locale
    );
    if (docxSection) text += `\n\n${docxSection}`;
  }
  if (!text.trim()) throw new Error(t('ipc.emptyMessage', {}, appLocale()));
  hintedThisTurn = false;
  // A failed or one-shot CLI exit used to reject every later send. Reopen the same session first.
  await chat.ensureAcceptingSend();
  chat.send(text);
  return { state: chat.status() };
});
ipcMain.handle('chat:stop', event => { fromWindow(event.sender); chat.stop(); return { state: chat.status() }; });
ipcMain.handle('chat:status', event => { fromWindow(event.sender); return { state: chat.status(), sessionId: chat.sessionIdValue() }; });
ipcMain.handle('chat:readiness', event => { fromWindow(event.sender); return chatReadiness(); });
ipcMain.handle('health:check', async event => {
  fromWindow(event.sender);
  const settings = projects.snapshot();
  const result = await checkEnvironment({ configuredPath: settings.cliPath });
  // A discovered standard installation should be usable immediately and remain selected
  // on later launches. An explicitly configured path is never silently replaced.
  if (!settings.cliPath && result.cliPath) {
    try {
      projects.setCliPath(validateCliPath(result.cliPath));
    } catch (error) {
      if (error instanceof CliValidationError) logCliDiagnostic(error.diagnostic);
    }
  }
  return result;
});
ipcMain.handle('chat:list', event => { fromWindow(event.sender); return sessions.list(); });
const modelCacheFile = () => path.join(app.getPath('userData'), 'model-catalog.json');
const MODEL_CACHE_MS = 30 * 60 * 1000;

function readModelCache(): { fetchedAt: number; models: CatalogModel[] } | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(modelCacheFile(), 'utf8'));
    if (!isPlainObject(data) || typeof data.fetchedAt !== 'number' || !Array.isArray(data.models)) return undefined;
    const models = data.models.filter((item): item is CatalogModel => isPlainObject(item) && typeof item.id === 'string' && typeof item.label === 'string' && (item.section === 'default' || item.section === 'recommended'));
    return { fetchedAt: data.fetchedAt, models };
  } catch { return undefined; }
}

ipcMain.handle('models:list', async (event, force: unknown) => {
  fromWindow(event.sender);
  const cached = readModelCache();
  const fresh = cached && Date.now() - cached.fetchedAt < MODEL_CACHE_MS;
  if (fresh && force !== true) return { models: cached.models, fromCache: true };
  const settings = projects.snapshot();
  if (!settings.cliPath) return { models: cached?.models ?? [], fromCache: !!cached, error: t('chat.guideMissingCli', {}, settings.language) };
  let cwd = app.getPath('home');
  const project = settings.projects.find(item => item.id === settings.activeProjectId);
  if (project && existsSync(project.directory)) cwd = project.directory;
  const probed = await probeModels(settings.cliPath, cwd, 15000, settings.language);
  if (probed.models.length > 0) {
    try { writeFileSync(modelCacheFile(), JSON.stringify({ fetchedAt: Date.now(), models: probed.models }), 'utf8'); } catch { /* cache is optional */ }
    return { models: probed.models, fromCache: false };
  }
  if (cached && cached.models.length > 0) return { models: cached.models, fromCache: true, error: probed.error };
  return { models: [], fromCache: false, error: probed.error || t('model.probe.empty', {}, settings.language) };
});

ipcMain.handle('chat:setPinned', (event, sessionId: unknown, pinned: unknown) => {
  fromWindow(event.sender);
  if (typeof sessionId !== 'string' || typeof pinned !== 'boolean') throw new Error(t('ipc.invalidSessionId', {}, appLocale()));
  const updated = sessions.setPinned(sessionId, pinned);
  if (!updated) throw new Error(t('ipc.sessionMissing', {}, appLocale()));
  return updated;
});

ipcMain.handle('chat:move', (event, sessionId: unknown, projectId: unknown) => {
  fromWindow(event.sender);
  if (typeof sessionId !== 'string' || typeof projectId !== 'string') throw new Error(t('ipc.invalidSessionId', {}, appLocale()));
  const project = projects.snapshot().projects.find(item => item.id === projectId);
  if (!project) throw new Error(t('project.notRegistered', {}, appLocale()));
  if (!sessions.get(sessionId)) throw new Error(t('ipc.sessionMissing', {}, appLocale()));
  const updated = sessions.move(sessionId, project.id, project.directory);
  if (chat.sessionIdValue() === sessionId) chatProject = { id: project.id, directory: project.directory };
  return updated;
});

ipcMain.handle('chat:delete', async (event, sessionId: unknown) => {
  fromWindow(event.sender);
  if (typeof sessionId !== 'string') throw new Error(t('ipc.invalidSessionId', {}, appLocale()));
  if (!sessions.get(sessionId)) throw new Error(t('ipc.sessionMissing', {}, appLocale()));
  if (chat.sessionIdValue() === sessionId) {
    if (chat.isBusy()) throw new Error(t('ipc.busySessionDelete', {}, appLocale()));
    chatProject = undefined;
    await chat.discardSettled();
  }
  sessions.remove(sessionId);
  return { removed: true };
});

ipcMain.handle('chat:rename', (event, sessionId: unknown, title: unknown) => {
  fromWindow(event.sender);
  if (typeof sessionId !== 'string' || typeof title !== 'string') throw new Error(t('ipc.invalidTitle', {}, appLocale()));
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) throw new Error(t('ipc.emptyTitle', {}, appLocale()));
  if (!sessions.get(sessionId)) throw new Error(t('ipc.unsavedSession', {}, appLocale()));
  sessions.touch(sessionId, { title: clean, titleEdited: true });
  return sessions.get(sessionId);
});

ipcMain.handle('chat:messages', (event, sessionId: unknown) => {
  fromWindow(event.sender);
  if (typeof sessionId !== 'string') throw new Error(t('ipc.invalidSessionId', {}, appLocale()));
  return sessions.loadMessages(sessionId) as ChatMessage[];
});
