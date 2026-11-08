import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ChatEvent, ChatLaunch, ChatMessage, ChatReadiness, ChatState, HealthCheckResult, HealthCheckRow, HealthStatus, Settings, SessionRecord, TerminalEvent } from '../shared/contracts';
import { errorHintText, type ErrorHint } from '../shared/error-hints';
import { modelSlashCommand, sessionTitleFromMessages, transcriptAfterLaunch } from '../shared/resume-plan';
import { pathFromFileUri } from '../shared/dropped-paths';
import { AttachmentMetadata, MAX_ATTACHMENTS, attachmentPathKey, buildPromptWithAttachments, dedupeAttachments, formatAttachmentSize } from '../shared/attachments';
import type { CatalogModel } from '../shared/model-catalog';
import { usableModel } from '../shared/error-hints';
import { applyStaticTranslations, isDefaultSessionTitle, isLocale, Locale, setI18nLocale, t, TranslationKey } from '../shared/i18n';
import { PRODUCT_NAME, PRODUCT_SHORT_NAME } from '../shared/brand';

declare global {
  interface Window {
    ccDesktop: {
      projects(): Promise<Settings>;
      addProject(): Promise<Settings>;
      activateProject(id: string): Promise<Settings>;
      removeProject(id: string): Promise<Settings>;
      selectCli(): Promise<Settings>;
      setLanguage(language: Locale): Promise<Settings>;
      start(cols: number, rows: number): Promise<{ state: string }>;
      stop(): Promise<{ state: string }>;
      write(data: string): void;
      resize(cols: number, rows: number): void;
      copy(text: string): void;
      onTerminal(listener: (event: TerminalEvent) => void): () => void;
      chatStart(launch: { resumeSessionId?: string; continueLatest?: boolean }): Promise<{ state: string; sessionId?: string; messages: ChatMessage[] }>;
      chatSend(input: string | { text: string; attachmentPaths: string[] }): Promise<{ state: string }>;
      selectAttachments(): Promise<{ attachments: AttachmentMetadata[]; rejected: number; omitted: number }>;
      inspectAttachments(paths: string[]): Promise<{ attachments: AttachmentMetadata[]; rejected: number; omitted: number }>;
      chatStop(): Promise<{ state: string }>;
      chatStatus(): Promise<{ state: string; sessionId?: string }>;
      chatReadiness(): Promise<ChatReadiness>;
      healthCheck(): Promise<HealthCheckResult>;
      chatList(): Promise<SessionRecord[]>;
      chatRename(sessionId: string, title: string): Promise<SessionRecord | undefined>;
      chatSetPinned(sessionId: string, pinned: boolean): Promise<SessionRecord>;
      chatMove(sessionId: string, projectId: string): Promise<SessionRecord>;
      chatDelete(sessionId: string): Promise<{ removed: boolean }>;
      models(force?: boolean): Promise<{ models: CatalogModel[]; fromCache: boolean; error?: string }>;
      chatMessages(sessionId: string): Promise<ChatMessage[]>;
      pathForFile(file: File): string;
      onChat(listener: (event: ChatEvent) => void): () => void;
    };
  }
}

const api = window.ccDesktop;
const content = document.getElementById('content')!;
const status = document.getElementById('status')!;
let locale: Locale = 'zh-CN';
setI18nLocale(locale);
applyStaticTranslations(document, locale);
document.title = PRODUCT_NAME;
document.getElementById('productBrand')!.textContent = PRODUCT_SHORT_NAME;
let sessionRecords: SessionRecord[] = [];
let modelCatalog: CatalogModel[] = [];
let pendingTitle: string | undefined;
let openedFreshChat = false;
let initialChatLaunchPending = false;
let sideFilter = '';
let chatDraft = '';
let languageChangeGeneration = 0;
let noticeText = '';
let noticeRender: (() => string) | undefined;
let historySearchText = '';

function paintMessage(text: string): void {
  const target = document.getElementById('message');
  if (target) target.textContent = text;
  if (chatErrorEl) {
    chatErrorEl.textContent = text;
    chatErrorEl.style.display = text ? 'block' : 'none';
    return;
  }
  if (!text) return;
  let banner = document.getElementById('appNotice');
  if (!banner) {
    banner = document.createElement('p');
    banner.id = 'appNotice';
    banner.className = 'chat-error';
    content.prepend(banner);
  }
  banner.textContent = text;
}

const message = (text: string) => {
  noticeText = text;
  noticeRender = undefined;
  paintMessage(text);
};

function showMessage(key: TranslationKey, params: Record<string, string | number> = {}): void {
  showMessageWith(() => t(key, params));
}

function showMessageWith(renderText: () => string): void {
  noticeRender = renderText;
  noticeText = renderText();
  paintMessage(noticeText);
}

let settings: Settings;
let page = 'chat';
let terminal: Terminal | undefined;
let fit: FitAddon | undefined;
let observer: ResizeObserver | undefined;
let active = false;
let terminalExited = false;
let terminalExitCode: number | undefined;
let terminalRawStatus: string | undefined;
const activeProject = () => settings?.projects.find(item => item.id === settings.activeProjectId);

// --- chat state ---
let chatMessages: ChatMessage[] = [];
let chatState: ChatState = 'idle';
let chatSessionId: string | undefined;
let chatModel: string | undefined;
let lastUserText: string | undefined;
let latestFailedMessageId: string | undefined;
let errorHintShown = false;
let activeErrorHint: ErrorHint | undefined;
let messageEls: Map<string, HTMLElement> = new Map();
let chatListEl: HTMLElement | undefined;
let chatListInnerEl: HTMLElement | undefined;
let chatStateEl: HTMLElement | undefined;
let chatSessionEl: HTMLElement | undefined;
let chatErrorEl: HTMLElement | undefined;
let errorHintEl: HTMLElement | undefined;
let healthPanelEl: HTMLElement | undefined;
let retryErrorBtnEl: HTMLButtonElement | undefined;
let composerInputEl: HTMLTextAreaElement | undefined;
let composerInnerEl: HTMLElement | undefined;
let composerSendBtn: HTMLButtonElement | undefined;
let composerStopBtn: HTMLButtonElement | undefined;
let attachmentChipsEl: HTMLElement | undefined;
let selectedAttachments: AttachmentMetadata[] = [];
let modelTriggerEl: HTMLButtonElement | undefined;
let modelPopoverEl: HTMLElement | undefined;
let modelOutsideClick: ((event: MouseEvent) => void) | undefined;
let stickToBottom = true;
let healthResult: HealthCheckResult | undefined;
let healthChecking = false;
let healthCheckGeneration = 0;
let healthError = false;
let healthDismissed = false;
let healthExpanded = false;
let healthCollapsed = false;

function setLocale(next: Locale, rerender: boolean): void {
  const draft = composerInputEl?.value ?? chatDraft;
  const transcriptTop = chatListEl?.scrollTop;
  const wasAtBottom = stickToBottom;
  const restoreComposerFocus = document.activeElement === composerInputEl;
  const selectionStart = composerInputEl?.selectionStart ?? null;
  const selectionEnd = composerInputEl?.selectionEnd ?? null;
  locale = next;
  setI18nLocale(next);
  applyStaticTranslations(document, next);
  if (typeof settings !== 'undefined') settings.language = next;
  if (!rerender || typeof settings === 'undefined') return;

  chatDraft = draft;
  // The renderer owns the terminal widget. Keep it mounted so switching language
  // cannot disturb a live PTY; all dictionary-backed static chrome is already updated.
  if (page === 'terminal') {
    updateTerminalChrome();
    if (terminalExited) paintTerminalExitStatus();
    if (noticeRender) {
      noticeText = noticeRender();
      paintMessage(noticeText);
    }
    return;
  }
  if (noticeRender) noticeText = noticeRender();
  render();
  if (noticeText) paintMessage(noticeText);
  if (page === 'chat' && composerInputEl) {
    composerInputEl.value = chatDraft;
    autoResizeTextarea(composerInputEl);
    if (restoreComposerFocus) {
      composerInputEl.focus();
      if (selectionStart !== null && selectionEnd !== null) composerInputEl.setSelectionRange(selectionStart, selectionEnd);
    }
    if (transcriptTop !== undefined && chatListEl) {
      chatListEl.scrollTop = transcriptTop;
      stickToBottom = wasAtBottom;
    }
  }
}

async function changeLanguage(next: unknown): Promise<void> {
  if (!isLocale(next) || next === locale || typeof settings === 'undefined') return;
  const previous = locale;
  const generation = ++languageChangeGeneration;
  setLocale(next, true);
  try {
    const updated = await api.setLanguage(next);
    if (generation === languageChangeGeneration) settings = updated;
  } catch (error) {
    if (generation === languageChangeGeneration) {
      setLocale(previous, true);
      message(error instanceof Error ? error.message : String(error));
    }
  }
}

function button(label: string, action: () => void, secondary = false): HTMLButtonElement {
  const item = document.createElement('button');
  item.textContent = label;
  item.className = secondary ? 'action secondary' : 'action';
  item.addEventListener('click', action);
  return item;
}

async function attempt(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    render();
  } catch (error) {
    message(error instanceof Error ? error.message : String(error));
  }
}

function teardown(): void {
  observer?.disconnect();
  observer = undefined;
  terminal?.dispose();
  terminal = undefined;
  fit = undefined;
  messageEls = new Map();
  chatListEl = undefined;
  chatListInnerEl = undefined;
  chatStateEl = undefined;
  chatSessionEl = undefined;
  chatErrorEl = undefined;
  errorHintEl = undefined;
  healthPanelEl = undefined;
  retryErrorBtnEl = undefined;
  composerInputEl = undefined;
  composerInnerEl = undefined;
  composerSendBtn = undefined;
  composerStopBtn = undefined;
  attachmentChipsEl = undefined;
  modelTriggerEl = undefined;
  modelPopoverEl = undefined;
  if (modelOutsideClick) {
    document.removeEventListener('click', modelOutsideClick);
    modelOutsideClick = undefined;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(s: string): string {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  let html = '';
  let inCode = false;
  let codeBuf: string[] = [];
  let codeLang = '';
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';

  const flushCode = () => {
    const langDisplay = codeLang ? escapeHtml(codeLang) : escapeHtml(t('chat.codeLanguage'));
    html += `<div class="codeblock-wrap"><div class="codeblock-bar"><span>${langDisplay}</span><button type="button" class="code-copy-btn">${escapeHtml(t('chat.copyCode'))}</button></div><pre class="codeblock"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre></div>`;
    codeBuf = [];
    inCode = false;
    codeLang = '';
  };

  const closeList = () => {
    if (inList) {
      html += listType === 'ul' ? '</ul>' : '</ol>';
      inList = false;
    }
  };

  for (const line of lines) {
    const codeMatch = line.match(/^```(.*)$/);
    if (codeMatch) {
      if (inCode) {
        flushCode();
      } else {
        inCode = true;
        codeLang = codeMatch[1].trim();
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const l = heading[1].length;
      html += `<h${l}>${inline(heading[2])}</h${l}>`;
      continue;
    }

    const blockquote = line.match(/^>\s?(.*)$/);
    if (blockquote) {
      closeList();
      html += `<blockquote>${inline(blockquote[1])}</blockquote>`;
      continue;
    }

    const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        closeList();
        html += '<ul>';
        inList = true;
        listType = 'ul';
      }
      html += `<li>${inline(ulMatch[1])}</li>`;
      continue;
    }

    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        closeList();
        html += '<ol>';
        inList = true;
        listType = 'ol';
      }
      html += `<li>${inline(olMatch[1])}</li>`;
      continue;
    }

    closeList();
    if (line.trim() === '') continue;
    html += `<p>${inline(line)}</p>`;
  }

  if (inCode) flushCode();
  closeList();
  return html;
}

function visibleBody(message: ChatMessage): string {
  let html = '';
  let liveTool = -1;
  if (message.state === 'streaming') {
    for (let index = message.blocks.length - 1; index >= 0; index -= 1) {
      const block = message.blocks[index];
      if (block.type === 'text') break;
      if (block.type === 'tool_use') {
        liveTool = index;
        break;
      }
    }
  }
  message.blocks.forEach((block, index) => {
    if (block.type === 'text') html += renderMarkdown(block.text);
    else if (block.type === 'tool_use') {
      const phase = index === liveTool ? 'is-running' : 'is-settled';
      html += `<div class="tooluse ${phase}"><span>${escapeHtml(t('chat.tool'))}</span> <code>${escapeHtml(block.name)}</code></div>`;
    }
  });
  return html;
}

/** Plain text only. Thinking must not pass through markdown italics. */
function thinkingDisclosure(message: ChatMessage): string {
  const thinking = message.blocks
    .filter((block): block is { type: 'thinking'; thinking: string } => block.type === 'thinking')
    .map(block => block.thinking.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!thinking) return '';
  return `<details class="thinking-block"><summary class="thinking-summary">${escapeHtml(t('chat.thinking'))}</summary><div class="thinking-content">${escapeHtml(thinking)}</div></details>`;
}

function messageContent(message: ChatMessage): string {
  const body = visibleBody(message);
  // While a turn is only thinking, show a status line. Do not paint the English trace.
  if (!body && message.state === 'streaming') {
    return `<div class="status-line thinking-pulse"><span class="pulse-dot"></span> ${escapeHtml(t('chat.thinkingNow'))}</div>`;
  }
  const thinking = body || message.state !== 'streaming' ? thinkingDisclosure(message) : '';
  let html = thinking + body;
  if (!html && message.state === 'interrupted') html = `<div class="status-line text-interrupted">${escapeHtml(t('chat.interruptedReply'))}</div>`;
  else if (!html && message.state === 'error') html = `<div class="status-line text-failed">${escapeHtml(t('chat.failedReply'))}</div>`;
  return html;
}

const STATUS_IDLE = 'brand/status/assistant-idle.png';
const STATUS_WORKING = 'brand/status/working-cerebrating.gif';

function statusSpriteFor(state: ChatState): string {
  return state === 'starting' || state === 'generating' || state === 'waiting' ? STATUS_WORKING : STATUS_IDLE;
}

function paintStatusSprite(img: HTMLImageElement | null, src: string): void {
  if (!img) return;
  if (img.classList.contains('home-mark')) img.classList.toggle('is-working', src === STATUS_WORKING);
  if (img.dataset.sprite === src) return;
  img.dataset.sprite = src;
  img.src = src;
}

function messageElement(message: ChatMessage): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg ${message.role}`;
  if (message.role === 'assistant' && message.state === 'streaming') el.classList.add('is-streaming');
  el.dataset.id = message.id;

  const head = document.createElement('div');
  head.className = 'msg-head';

  if (message.role === 'user') {
    head.textContent = t('chat.user');
  } else {
    const sprite = document.createElement('img');
    sprite.className = 'status-sprite';
    sprite.alt = '';
    sprite.width = 28;
    sprite.height = 28;
    sprite.src = message.state === 'streaming' ? STATUS_WORKING : STATUS_IDLE;
    const authorSpan = document.createElement('span');
    authorSpan.textContent = t('chat.assistant');
    head.append(sprite, authorSpan);
    const model = usableModel(message.model);
    if (model) {
      const modelTag = document.createElement('span');
      modelTag.className = 'msg-model-tag';
      modelTag.textContent = model;
      head.append(modelTag);
    }
  }

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = messageContent(message);

  el.append(head, body);
  return el;
}

function updateMessage(message: ChatMessage): void {
  const el = messageEls.get(message.id);
  if (!el) return;
  el.classList.toggle('is-streaming', message.role === 'assistant' && message.state === 'streaming');
  const body = el.querySelector('.msg-body');
  if (body) body.innerHTML = messageContent(message);
  if (message.role === 'assistant') {
    paintStatusSprite(el.querySelector('.status-sprite'), message.state === 'streaming' ? STATUS_WORKING : STATUS_IDLE);
  }
}

function scrollTranscript(force = false): void {
  if (!chatListEl) return;
  const distance = chatListEl.scrollHeight - chatListEl.scrollTop - chatListEl.clientHeight;
  if (force || stickToBottom || distance < 96) {
    chatListEl.scrollTop = chatListEl.scrollHeight;
  }
}

function syncEmptyState(): void {
  if (!chatListInnerEl) return;
  const existing = chatListInnerEl.querySelector('.chat-empty-container');
  if (chatMessages.length > 0) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const box = document.createElement('div');
  box.className = 'chat-empty-container';

  const title = document.createElement('div');
  title.className = 'empty-title';
  title.textContent = chatSessionId ? t('chat.emptyReadyTitle') : t('chat.emptyStartTitle');

  const desc = document.createElement('div');
  desc.className = 'empty-desc';
  desc.textContent = chatSessionId
    ? t('chat.emptyReadyDescription')
    : t('chat.emptyStartDescription');

  const suggestions = document.createElement('div');
  suggestions.className = 'empty-suggestions';

  const prompts = [
    t('chat.suggestionGreeting'),
    t('chat.suggestionSteps'),
    t('chat.suggestionExplain'),
    t('chat.suggestionProjectIntro')
  ];

  for (const prompt of prompts) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggestion-chip';
    chip.textContent = prompt;
    chip.addEventListener('click', () => {
      if (composerInputEl) {
        composerInputEl.value = prompt;
        chatDraft = prompt;
        autoResizeTextarea(composerInputEl);
        composerInputEl.focus();
        syncComposerChrome();
      }
    });
    suggestions.append(chip);
  }

  const tip = document.createElement('div');
  tip.className = 'empty-tip';
  tip.textContent = t('chat.emptyTip');

  box.append(title, desc, suggestions, tip);
  chatListInnerEl.append(box);
}

function appendChatMessage(message: ChatMessage, forceScroll = false): void {
  chatMessages.push(message);
  syncEmptyState();
  if (chatListInnerEl) {
    const el = messageElement(message);
    messageEls.set(message.id, el);
    chatListInnerEl.append(el);
    scrollTranscript(forceScroll);
  }
}

function clearErrorHint(): void {
  errorHintShown = false;
  activeErrorHint = undefined;
  if (!errorHintEl) return;
  errorHintEl.replaceChildren();
  errorHintEl.style.display = 'none';
  retryErrorBtnEl = undefined;
}

function renderErrorHint(hint: ErrorHint): void {
  errorHintShown = true;
  activeErrorHint = hint;
  if (!errorHintEl) return;
  message('');
  const localized = errorHintText(hint, locale);

  const title = document.createElement('strong');
  title.className = 'error-hint-title';
  title.textContent = localized.title;
  const detail = document.createElement('p');
  detail.className = 'error-hint-detail';
  detail.textContent = localized.detail;
  const nextStep = document.createElement('p');
  nextStep.className = 'error-hint-next';
  nextStep.textContent = t('chat.errorNextStep', { text: localized.nextStep });

  const retry = button(t('chat.retry'), () => {
    if (!lastUserText) return;
    const retryText = lastUserText;
    deliverChat(retryText, () => api.chatSend(retryText));
  }, true);
  retry.type = 'button';
  retry.classList.add('error-hint-retry');
  retryErrorBtnEl = retry;

  const rawDetails = document.createElement('details');
  rawDetails.className = 'error-hint-raw';
  const rawSummary = document.createElement('summary');
  rawSummary.textContent = t('chat.rawError');
  const rawText = document.createElement('pre');
  rawText.textContent = hint.raw;
  rawDetails.append(rawSummary, rawText);

  errorHintEl.replaceChildren(title, detail, nextStep, retry, rawDetails);
  errorHintEl.style.display = 'block';
  updateComposerButtons();
}

function healthMark(status: HealthStatus): string {
  return status === 'ok' ? '✓' : status === 'warn' ? '!' : '×';
}

function renderHealthPanel(parent: HTMLElement, forceVisible = false): void {
  if (healthDismissed && !forceVisible) {
    healthPanelEl?.remove();
    healthPanelEl = undefined;
    return;
  }
  const oldPanel = healthPanelEl;
  const panel = document.createElement('section');
  panel.className = 'health-panel';
  panel.setAttribute('aria-live', 'polite');
  if (healthResult) panel.dataset.status = healthResult.status;
  healthPanelEl = panel;

  const result = healthResult;
  const showRows = !!result && !healthCollapsed && (result.status !== 'ok' || healthExpanded);
  if (showRows && result) {
    const heading = document.createElement('div');
    heading.className = 'health-heading';
    const title = document.createElement('strong');
    title.textContent = t('health.title');
    const actions = document.createElement('div');
    actions.className = 'health-actions';
    const retry = button(t('health.retry'), () => { void refreshHealth(); }, true);
    actions.append(retry, button(t('health.collapse'), () => { healthCollapsed = true; renderHealthPanel(parent, forceVisible); }, true));
    if (!forceVisible) actions.append(button(t('health.close'), () => { healthDismissed = true; renderHealthPanel(parent); }, true));
    heading.append(title, actions);
    panel.append(heading);

    for (const row of result.rows) {
      const item = document.createElement('div');
      item.className = `health-row health-${row.status}`;
      const icon = document.createElement('span');
      icon.className = 'health-icon';
      icon.setAttribute('aria-label', row.status === 'ok' ? t('health.ok') : row.status === 'warn' ? t('health.warning') : t('health.error'));
      icon.textContent = healthMark(row.status);
      const body = document.createElement('div');
      body.className = 'health-row-body';
      const label = document.createElement('strong');
      label.textContent = t(row.labelCode, {}, locale);
      const detail = document.createElement('span');
      detail.textContent = t(row.detailCode, row.detailParams, locale);
      body.append(label, detail);
      if (row.fixCode) {
        const fix = document.createElement('span');
        fix.className = 'health-fix';
        fix.textContent = t('health.fixPrefix', { text: t(row.fixCode, row.fixParams, locale) });
        body.append(fix);
      }
      item.append(icon, body);
      panel.append(item);
    }
    if (healthChecking) {
      const note = document.createElement('p');
      note.className = 'health-note';
      note.textContent = t('health.checkingAgain');
      panel.append(note);
    }
  } else {
    const summary = document.createElement('div');
    summary.className = 'health-summary';
    const icon = document.createElement('span');
    icon.className = `health-icon ${result ? `health-${result.status}` : ''}`;
    icon.textContent = healthError ? '!' : result ? healthMark(result.status) : '…';
    const label = document.createElement('strong');
    label.textContent = healthError ? t('health.failed') : healthChecking && !result ? t('health.checking') : result?.status === 'ok' ? t('health.healthy') : t('health.issues');
    summary.append(icon, label);
    if (result?.status === 'ok' && !healthExpanded) {
      summary.append(button(t('health.details'), () => { healthExpanded = true; healthCollapsed = false; renderHealthPanel(parent, forceVisible); }, true));
    } else if (result && result.status !== 'ok') {
      summary.append(button(t('health.details'), () => { healthCollapsed = false; renderHealthPanel(parent, forceVisible); }, true));
    }
    const retry = button(t('health.retry'), () => { void refreshHealth(); }, true);
    summary.append(retry);
    if (!forceVisible && result) summary.append(button(t('health.close'), () => { healthDismissed = true; renderHealthPanel(parent); }, true));
    panel.append(summary);
  }

  if (oldPanel?.parentElement === parent) oldPanel.replaceWith(panel);
  else if (parent === content && page === 'chat') {
    const lane = parent.querySelector('.chat-lane');
    if (lane) parent.insertBefore(panel, lane);
    else parent.append(panel);
  } else parent.append(panel);
}

function updateHealthPanel(): void {
  const parent = healthPanelEl?.parentElement;
  if (parent) renderHealthPanel(parent, page === 'settings');
}

async function refreshHealth(): Promise<void> {
  const generation = ++healthCheckGeneration;
  healthChecking = true;
  healthError = false;
  updateHealthPanel();
  try {
    const result = await api.healthCheck();
    if (generation !== healthCheckGeneration) return;
    healthResult = result;
    if (typeof settings !== 'undefined' && !settings.cliPath && result.cliPath) settings.cliPath = result.cliPath;
  } catch {
    if (generation === healthCheckGeneration) healthError = true;
  } finally {
    if (generation === healthCheckGeneration) {
      healthChecking = false;
      updateHealthPanel();
    }
  }
}

function applyChatEvent(event: ChatEvent): void {
  if (event.type === 'state') {
    chatState = event.state;
    updateChatStatus();
    if (event.state === 'interrupted') {
      showMessage('chat.stoppedNotice');
    } else if (event.state === 'failed' && event.message && !errorHintShown) {
      message(event.message);
    }
    return;
  }
  if (event.type === 'init') {
    if (event.sessionId) chatSessionId = event.sessionId;
    chatModel = usableModel(event.model) ?? chatModel;
    updateChatStatus();
    void refreshSessions();
    return;
  }
  if (event.type === 'user_message') {
    latestFailedMessageId = undefined;
    clearErrorHint();
    message('');
    appendChatMessage(event.message, true);
    healthPanelEl?.remove();
    healthPanelEl = undefined;
    if (pendingTitle && chatSessionId) {
      const title = pendingTitle;
      pendingTitle = undefined;
      void api.chatRename(chatSessionId, title).then(updated => {
        if (updated) rememberRecord(updated);
        paintTitle();
        paintSidebar();
      }).catch(error => message(error instanceof Error ? error.message : String(error)));
    } else {
      paintTitle();
      void refreshSessions();
    }
    return;
  }
  if (event.type === 'assistant_start') {
    chatState = 'generating';
    const model = usableModel(event.model);
    if (model) chatModel = model;
    updateChatStatus();
    const msg: ChatMessage = {
      id: event.messageId,
      role: 'assistant',
      blocks: [],
      state: 'streaming',
      model: model ?? chatModel,
      createdAt: new Date().toISOString()
    };
    appendChatMessage(msg, true);
    return;
  }
  if (event.type === 'text_delta') {
    chatState = 'generating';
    updateChatStatus();
    const m = chatMessages.find(x => x.id === event.messageId);
    if (m) {
      const last = m.blocks[m.blocks.length - 1];
      if (last && last.type === 'text') {
        last.text += event.text;
      } else {
        m.blocks.push({ type: 'text', text: event.text });
      }
      updateMessage(m);
      scrollTranscript();
    }
    return;
  }
  if (event.type === 'thinking_delta') {
    chatState = 'generating';
    updateChatStatus();
    const m = chatMessages.find(x => x.id === event.messageId);
    if (m) {
      let think = m.blocks.find((b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking');
      if (!think) {
        think = { type: 'thinking', thinking: '' };
        m.blocks.push(think);
      }
      think.thinking += event.text;
      updateMessage(m);
      scrollTranscript();
    }
    return;
  }
  if (event.type === 'tool_use') {
    chatState = 'generating';
    updateChatStatus();
    const m = chatMessages.find(x => x.id === event.messageId);
    if (m) {
      m.blocks.push({ type: 'tool_use', name: event.name, input: event.input });
      updateMessage(m);
      scrollTranscript();
    }
    return;
  }
  if (event.type === 'assistant_end') {
    const m = chatMessages.find(x => x.id === event.messageId);
    if (m) {
      m.state = event.state;
      updateMessage(m);
    }
    if (event.state === 'complete') chatState = 'completed';
    else if (event.state === 'interrupted') chatState = 'interrupted';
    else if (event.state === 'error') chatState = 'failed';
    updateChatStatus();
    return;
  }
  if (event.type === 'turn_complete') {
    latestFailedMessageId = event.isError ? event.messageId : undefined;
    const m = chatMessages.find(x => x.id === event.messageId);
    if (m && m.state === 'streaming') {
      m.state = event.isError ? 'error' : 'complete';
      updateMessage(m);
    }
    chatState = event.isError ? 'failed' : 'completed';
    updateChatStatus();
    void refreshSessions();
    return;
  }
  if (event.type === 'error_hint') {
    if (chatState !== 'failed') return;
    if (event.messageId && latestFailedMessageId !== event.messageId) return;
    renderErrorHint(event.hint);
    return;
  }
  if (event.type === 'error') {
    message(event.code === 'transcript-mismatch' ? t('chat.transcriptMismatch') : event.message);
    if (event.code === 'transcript-mismatch') {
      chatMessages = [];
      messageEls.clear();
      if (chatListInnerEl) {
        chatListInnerEl.replaceChildren();
        syncEmptyState();
      }
    }
    // Status comes from state events. A stderr line must not freeze the composer.
  }
}

function ensureStatusChip(host: HTMLElement): void {
  host.classList.add('status-chip');
  if (!host.querySelector('.status-text')) {
    host.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    const text = document.createElement('span');
    text.className = 'status-text';
    host.append(dot, text);
  }
}

function modelLabel(): string {
  return chatModel ? chatModel : t('chat.model');
}

function sameModel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function displayTitle(): string {
  const rec = sessionRecords.find(item => item.sessionId === chatSessionId);
  const title = sessionTitleFromMessages(chatMessages, rec);
  if (pendingTitle) return pendingTitle;
  if (!title || isDefaultSessionTitle(title)) return t('sidebar.newChat');
  return title;
}

function localizedSessionTitle(title: string | undefined): string {
  return !title || isDefaultSessionTitle(title) ? t('chat.defaultSessionTitle') : title;
}

function paintTitle(): void {
  const wrap = document.getElementById('titleEdit');
  if (!wrap) return;
  let host = document.getElementById('chatTitle') as HTMLButtonElement | null;
  if (!host) {
    host = document.createElement('button');
    host.id = 'chatTitle';
    host.type = 'button';
    host.className = 'chat-title';
    host.addEventListener('click', () => beginRename());
    const pencil = document.createElement('button');
    pencil.id = 'renameTitle';
    pencil.type = 'button';
    pencil.className = 'icon-btn';
    pencil.setAttribute('aria-label', t('sidebar.rename'));
    pencil.append(svg('pencil'));
    pencil.addEventListener('click', () => beginRename());
    wrap.replaceChildren(host, pencil);
  }
  host.textContent = displayTitle();
  host.title = t('sidebar.renameTitle');
}

function rememberRecord(record: SessionRecord): void {
  const index = sessionRecords.findIndex(item => item.sessionId === record.sessionId);
  if (index >= 0) sessionRecords[index] = record;
  else sessionRecords.unshift(record);
}

async function refreshSessions(): Promise<void> {
  try { sessionRecords = await api.chatList(); }
  catch { return; }
  paintTitle();
  paintSidebar();
}

function paintStatusChip(host: HTMLElement | undefined, state: ChatState, label: string): void {
  if (!host) return;
  ensureStatusChip(host);
  host.dataset.state = state;
  const text = host.querySelector('.status-text');
  if (text) text.textContent = label;
  paintStatusSprite(document.querySelector<HTMLImageElement>('#homeMark'), statusSpriteFor(state));
  if (modelTriggerEl) {
    const labelEl = modelTriggerEl.querySelector('span');
    if (labelEl) labelEl.textContent = modelLabel();
    modelTriggerEl.title = chatModel ? t('chat.currentModel', { model: chatModel }) : t('chat.chooseModel');
  }
  paintTitle();
}

function updateChatStatus(): void {
  const label: Record<ChatState, string> = {
    idle: t('status.idle'),
    starting: t('chat.starting'),
    generating: t('chat.generating'),
    waiting: t('chat.waitingPermission'),
    completed: t('chat.completed'),
    interrupted: t('chat.interrupted'),
    failed: t('chat.failed')
  };

  const stateText = label[chatState] || t('status.idle');
  paintStatusChip(chatStateEl, chatState, stateText);

  paintStatusSprite(document.querySelector<HTMLImageElement>('#homeMark'), statusSpriteFor(chatState));
  if (page !== 'terminal') paintStatusChip(status, chatState, stateText);
  updateComposerButtons();
}

function syncComposerChrome(): void {
  const isBusy = chatState === 'generating' || chatState === 'starting' || chatState === 'waiting';
  composerInnerEl?.classList.toggle('is-busy', isBusy);
  const ready = !isBusy && Boolean(composerInputEl?.value.trim());
  composerSendBtn?.classList.toggle('is-ready', ready);
}

function updateComposerButtons(): void {
  const isBusy = chatState === 'generating' || chatState === 'starting' || chatState === 'waiting';
  if (composerSendBtn) composerSendBtn.disabled = isBusy;
  if (composerStopBtn) composerStopBtn.disabled = !isBusy;
  if (retryErrorBtnEl) retryErrorBtnEl.disabled = isBusy || !lastUserText;
  syncComposerChrome();
}

function attachmentIcon(category: AttachmentMetadata['category']): string {
  const labels: Record<AttachmentMetadata['category'], string> = {
    image: t('chat.attachmentIconImage'),
    code: '</>',
    pdf: 'PDF',
    office: t('chat.attachmentIconOffice'),
    archive: t('chat.attachmentIconArchive'),
    other: t('chat.attachmentIconOther')
  };
  return labels[category];
}

function renderAttachmentChips(): void {
  const host = attachmentChipsEl;
  if (!host) return;
  host.replaceChildren();
  host.hidden = selectedAttachments.length === 0;
  for (const attachment of selectedAttachments) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.title = attachment.tooltipCode
      ? t(attachment.tooltipCode, attachment.tooltipParams, locale)
      : attachment.path;
    chip.dataset.category = attachment.category;
    if (attachment.unsupported) chip.dataset.unsupported = 'true';
    if (attachment.extractionStatus === 'error') chip.dataset.error = 'true';
    if (attachment.extractionStatus === 'extracted') chip.dataset.extracted = 'true';

    const icon = document.createElement('span');
    icon.className = 'attachment-icon';
    icon.textContent = attachmentIcon(attachment.category);
    icon.setAttribute('aria-hidden', 'true');

    const details = document.createElement('span');
    details.className = 'attachment-details';
    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = attachment.name;
    const size = document.createElement('span');
    size.className = 'attachment-size';
    size.textContent = Number.isFinite(attachment.size) && attachment.size >= 0
      ? formatAttachmentSize(attachment.size, locale)
      : t('chat.unknownSize');
    details.append(name, size);
    if (attachment.extractionStatus) {
      const extraction = document.createElement('span');
      extraction.className = 'attachment-extraction-status';
      extraction.textContent = attachment.extractionStatus === 'extracted'
        ? typeof attachment.extractedCharacters === 'number'
          ? t('chat.extractedTextCount', { count: attachment.extractedCharacters })
          : t('chat.extractedText')
        : t('chat.readFailed');
      details.append(extraction);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', t('chat.removeAttachment', { name: attachment.name }));
    remove.title = t('chat.removeAttachment', { name: attachment.name });
    remove.addEventListener('click', () => {
      const key = attachmentPathKey(attachment.path);
      selectedAttachments = selectedAttachments.filter(item => attachmentPathKey(item.path) !== key);
      renderAttachmentChips();
    });
    chip.append(icon, details, remove);
    host.append(chip);
  }
}

function addAttachmentInspection(result: { attachments: AttachmentMetadata[]; rejected: number; omitted: number }): void {
  const previousCount = selectedAttachments.length;
  const combined = dedupeAttachments([...selectedAttachments, ...result.attachments]);
  const mergeOmitted = Math.max(0, combined.length - MAX_ATTACHMENTS);
  selectedAttachments = combined.slice(0, MAX_ATTACHMENTS);
  renderAttachmentChips();

  const added = selectedAttachments.length - previousCount;
  const warnings: Array<() => string> = [];
  if (result.rejected > 0) warnings.push(() => t('chat.rejectedAttachments', { count: result.rejected }));
  const omitted = result.omitted + mergeOmitted;
  if (omitted > 0) warnings.push(() => t('chat.omittedAttachments', { count: omitted }));
  if (warnings.length > 0) {
    showMessageWith(() => {
      const parts = [
        ...(added > 0 ? [t('chat.addedAttachments', { count: added })] : []),
        ...warnings.map(renderWarning => renderWarning())
      ];
      return parts.join(locale === 'zh-CN' ? '' : ' ');
    });
  }
}

async function inspectAndAddAttachments(paths: string[]): Promise<void> {
  try {
    addAttachmentInspection(await api.inspectAttachments(paths));
  } catch (error) {
    message(error instanceof Error ? error.message : String(error));
  }
}

function autoResizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  const newHeight = Math.min(200, Math.max(52, textarea.scrollHeight));
  textarea.style.height = `${newHeight}px`;
}

function isSlashCommand(text: string): boolean {
  return /^\/\S+/.test(text.trim());
}

function lastRealUserText(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item.role !== 'user') continue;
    const text = item.blocks
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
    if (text && !isSlashCommand(text)) return text;
  }
  return undefined;
}

async function launchChat(kind: 'new' | 'continue' | 'resume', launch: ChatLaunch = {}): Promise<void> {
  const previousState = chatState;
  chatState = 'starting';
  updateChatStatus();
  try {
    const started = await api.chatStart(kind === 'new' ? {} : launch);
    const view = transcriptAfterLaunch(kind, started);
    if (kind === 'new') {
      chatMessages = [];
      chatSessionId = undefined;
      chatModel = undefined;
      lastUserText = undefined;
      latestFailedMessageId = undefined;
      clearErrorHint();
    } else {
      // Continue and restore paint the seeded transcript. Do not clear it.
      chatMessages = view.messages;
      chatSessionId = view.sessionId || launch.resumeSessionId || chatSessionId;
      chatModel = [...view.messages].reverse().map(item => usableModel(item.model)).find((model): model is string => !!model);
      lastUserText = lastRealUserText(view.messages);
      latestFailedMessageId = undefined;
      clearErrorHint();
    }
    chatState = (started.state as ChatState) || 'idle';
    page = 'chat';
  } catch (error) {
    chatState = previousState;
    updateChatStatus();
    throw error;
  }
}

function renderChat(): void {
  const view = document.createElement('div');
  view.id = 'chatView';

  chatErrorEl = document.createElement('p');
  chatErrorEl.className = 'chat-error';
  chatErrorEl.style.display = 'none';

  errorHintEl = document.createElement('section');
  errorHintEl.className = 'error-hint-card';
  errorHintEl.setAttribute('aria-live', 'polite');
  errorHintEl.style.display = 'none';

  // Centered Chat Lane & List
  const lane = document.createElement('div');
  lane.className = 'chat-lane';

  const list = document.createElement('div');
  list.className = 'chat-list';
  list.setAttribute('role', 'log');
  list.setAttribute('aria-label', t('chat.conversationLog'));
  chatListEl = list;
  stickToBottom = true;

  list.addEventListener('scroll', () => {
    stickToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 96;
  });

  // Delegate copy button clicks
  list.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const copyBtn = target.closest<HTMLButtonElement>('.code-copy-btn');
    if (copyBtn) {
      const codeEl = copyBtn.closest('.codeblock-wrap')?.querySelector('code');
      if (codeEl) {
        api.copy(codeEl.textContent || '');
        copyBtn.textContent = t('chat.copied');
        copyBtn.classList.add('is-copied');
        setTimeout(() => {
          copyBtn.textContent = t('chat.copyCode');
          copyBtn.classList.remove('is-copied');
        }, 1500);
      }
    }
  });

  const inner = document.createElement('div');
  inner.className = 'chat-list-inner';
  chatListInnerEl = inner;
  list.append(inner);

  for (const msg of chatMessages) {
    const el = messageElement(msg);
    messageEls.set(msg.id, el);
    inner.append(el);
  }
  syncEmptyState();

  // Sticky Composer
  const composerWrap = document.createElement('div');
  composerWrap.className = 'chat-composer-wrap';

  const composerInner = document.createElement('div');
  composerInner.className = 'chat-composer-inner';
  composerInnerEl = composerInner;

  const attachmentChips = document.createElement('div');
  attachmentChips.className = 'attachment-chips';
  attachmentChips.hidden = true;
  attachmentChipsEl = attachmentChips;
  renderAttachmentChips();

  const textarea = document.createElement('textarea');
  textarea.className = 'chat-composer-textarea';
  textarea.placeholder = t('chat.composerPlaceholder');
  textarea.rows = 2;
  textarea.value = chatDraft;
  composerInputEl = textarea;

  textarea.addEventListener('input', () => {
    chatDraft = textarea.value;
    autoResizeTextarea(textarea);
    syncComposerChrome();
  });
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat(textarea);
    }
  });

  const bar = document.createElement('div');
  bar.className = 'chat-composer-bar';

  const leading = document.createElement('div');
  leading.className = 'composer-leading';

  const modelTrigger = document.createElement('button');
  modelTrigger.type = 'button';
  modelTrigger.className = 'model-trigger';
  modelTrigger.setAttribute('aria-haspopup', 'menu');
  modelTrigger.setAttribute('aria-expanded', 'false');
  const modelLabelEl = document.createElement('span');
  modelLabelEl.textContent = modelLabel();
  modelTrigger.append(modelLabelEl, svg('chevron'));
  modelTriggerEl = modelTrigger;

  const popover = document.createElement('div');
  popover.className = 'model-menu';
  popover.hidden = true;
  popover.setAttribute('role', 'menu');
  popover.setAttribute('aria-label', t('model.choose'));
  modelPopoverEl = popover;

  const setPopover = (open: boolean) => {
    popover.hidden = !open;
    modelTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) void loadModelMenu();
  };
  modelTrigger.addEventListener('click', () => setPopover(popover.hidden));
  if (modelOutsideClick) document.removeEventListener('click', modelOutsideClick);
  modelOutsideClick = event => {
    if (popover.hidden) return;
    const target = event.target;
    if (target instanceof Node && (popover.contains(target) || modelTrigger.contains(target))) return;
    setPopover(false);
  };
  document.addEventListener('click', modelOutsideClick);
  renderModelMenu();

  const hint = document.createElement('span');
  hint.className = 'composer-hint';
  hint.textContent = t('chat.composerHint');

  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'attachment-add';
  attachBtn.setAttribute('aria-label', t('chat.addAttachment'));
  attachBtn.title = t('chat.addAttachment');
  attachBtn.append(svg('paperclip'), document.createTextNode(t('chat.addAttachment')));
  attachBtn.addEventListener('click', () => {
    void api.selectAttachments().then(addAttachmentInspection).catch(error => message(error instanceof Error ? error.message : String(error)));
  });
  leading.append(modelTrigger, attachBtn, hint);

  const controls = document.createElement('div');
  controls.className = 'composer-actions';

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'btn-stop';
  stopBtn.textContent = t('chat.stop');
  stopBtn.addEventListener('click', () => {
    chatState = 'interrupted';
    updateChatStatus();
    void api.chatStop().catch(e => message(e instanceof Error ? e.message : String(e)));
  });
  composerStopBtn = stopBtn;

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'btn-send';
  sendBtn.textContent = t('chat.send');
  sendBtn.addEventListener('click', () => { sendChat(textarea); });
  composerSendBtn = sendBtn;

  controls.append(stopBtn, sendBtn);
  bar.append(leading, controls);
  composerInner.append(attachmentChips, textarea, popover, bar);
  composerWrap.append(composerInner);

  lane.append(list, composerWrap);
  view.append(chatErrorEl, errorHintEl);
  if (noticeText) {
    noticeText = noticeRender ? noticeRender() : noticeText;
    chatErrorEl.textContent = noticeText;
    chatErrorEl.style.display = 'block';
  }
  if (chatMessages.length === 0) renderHealthPanel(view);
  view.append(lane);
  content.append(view);

  updateChatStatus();
  if (activeErrorHint) renderErrorHint(activeErrorHint);
  scrollTranscript(true);
  if (chatMessages.length === 0) textarea.focus();

  void api.chatReadiness().then(r => {
    if (r.missing === 'project') {
      showChatGuide(view, t('chat.guideMissingProjectTitle'), t('chat.guideMissingProject'), 'projects', [textarea, sendBtn]);
    } else if (r.missing === 'cli') {
      showChatGuide(view, t('chat.guideMissingCliTitle'), t('chat.guideMissingCli'), 'settings', [textarea, sendBtn]);
    }
  }).catch(() => { /* readiness unavailable; leave default empty state */ });
}

function showChatGuide(view: HTMLElement, title: string, hint: string, targetPage: string, disable: HTMLElement[]): void {
  const box = document.createElement('div');
  box.className = 'chat-guide';
  const h = document.createElement('strong');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = hint;
  const go = button(t('chat.openSettings'), () => { page = targetPage; render(); });
  box.append(h, p, go);
  const lane = view.querySelector('.chat-lane');
  if (lane) view.insertBefore(box, lane);
  else view.append(box);
  for (const el of disable) el.setAttribute('disabled', 'disabled');
}

function deliverChat(
  text: string,
  send?: () => Promise<{ state: string }>,
  onSuccess?: () => void,
  onFailure?: () => void
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (chatState === 'starting' || chatState === 'generating' || chatState === 'waiting') {
    showMessage('chat.busyNotice');
    return false;
  }
  clearErrorHint();
  message('');
  latestFailedMessageId = undefined;
  if (!isSlashCommand(trimmed)) lastUserText = trimmed;
  if (modelPopoverEl) modelPopoverEl.hidden = true;
  if (modelTriggerEl) modelTriggerEl.setAttribute('aria-expanded', 'false');
  chatState = 'generating';
  updateChatStatus();
  stickToBottom = true;
  scrollTranscript(true);
  void (send ? send() : api.chatSend(trimmed)).then(() => onSuccess?.()).catch(error => {
    chatState = 'failed';
    updateChatStatus();
    onFailure?.();
    message(error instanceof Error ? error.message : String(error));
  });
  return true;
}

function svg(name: 'plus' | 'folder' | 'chevron' | 'pencil' | 'search' | 'gear' | 'check' | 'terminal' | 'paperclip' | 'pin' | 'dots'): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  const d: Record<typeof name, string> = {
    plus: 'M12 5v14M5 12h14',
    folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-10Z',
    chevron: 'M7 10l5 5 5-5',
    pencil: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z',
    search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5.2-1.8L20 20',
    gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    check: 'M5 12.5 10 17l9-10',
    terminal: 'M5 7l6 5-6 5M13 17h6',
    paperclip: 'M21.4 11.1 12.7 19.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
    pin: 'M12 21s-6-4.6-6-10a6 6 0 0 1 12 0c0 5.4-6 10-6 10zM12 11.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z',
    dots: 'M6 12.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zM12 12.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zM18 12.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z'
  };
  path.setAttribute('d', d[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  el.append(path);
  return el;
}

function menuRows(): CatalogModel[] {
  const rows = modelCatalog.map(model => ({ ...model }));
  if (chatModel && !rows.some(model => sameModel(model.id, chatModel!))) {
    rows.unshift({ id: chatModel, label: chatModel, section: 'default' });
  }
  return rows;
}

function renderModelMenu(statusText?: string): void {
  const popover = modelPopoverEl;
  if (!popover) return;
  popover.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'model-menu-title';
  heading.textContent = t('model.choose');
  popover.append(heading);
  if (statusText) {
    const note = document.createElement('p');
    note.className = 'model-menu-note';
    note.textContent = statusText;
    popover.append(note);
  }
  const rows = menuRows();
  for (const section of ['default', 'recommended'] as const) {
    const group = rows.filter(model => model.section === section);
    if (group.length === 0) continue;
    const label = document.createElement('div');
    label.className = 'model-section';
    label.textContent = section === 'default' ? t('model.default') : t('model.recommended');
    popover.append(label);
    for (const model of group) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'model-row-btn';
      row.setAttribute('role', 'menuitemradio');
      const active = !!chatModel && sameModel(model.id, chatModel);
      row.setAttribute('aria-checked', active ? 'true' : 'false');
      const name = document.createElement('span');
      name.textContent = model.label === model.id ? model.label : `${model.label}`;
      row.append(name);
      if (model.label !== model.id) {
        const id = document.createElement('small');
        id.textContent = model.id;
        row.append(id);
      }
      if (active) row.append(svg('check'));
      row.addEventListener('click', () => applyModelChoice(model.id));
      popover.append(row);
    }
  }
  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'model-custom-toggle';
  custom.textContent = t('model.custom');
  const hatch = document.createElement('div');
  hatch.className = 'model-custom';
  hatch.hidden = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('model.customPlaceholder');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const use = document.createElement('button');
  use.type = 'button';
  use.textContent = t('model.use');
  use.addEventListener('click', () => applyModelChoice(input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); applyModelChoice(input.value); }
  });
  custom.addEventListener('click', () => { hatch.hidden = false; input.focus(); });
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'model-refresh';
  refresh.textContent = t('model.refresh');
  refresh.addEventListener('click', () => { void loadModelMenu(true); });
  hatch.append(input, use);
  popover.append(custom, hatch, refresh);
}

async function loadModelMenu(force = false): Promise<void> {
  renderModelMenu(modelCatalog.length ? undefined : t('model.loading'));
  try {
    const result = await api.models(force);
    modelCatalog = result.models;
    const note = result.models.length === 0
      ? (result.error || t('model.empty'))
      : (result.error ? t('model.cached', { error: result.error }) : undefined);
    renderModelMenu(note);
  } catch (error) {
    renderModelMenu(error instanceof Error ? error.message : t('model.unavailable'));
  }
}

function sessionRow(rec: SessionRecord): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'side-session-wrap';
  if (rec.pinned) wrap.classList.add('is-pinned');

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'side-session';
  if (rec.sessionId === chatSessionId) row.classList.add('active');
  const titleRow = document.createElement('span');
  titleRow.className = 'side-session-title';
  if (rec.pinned) {
    const pin = document.createElement('span');
    pin.className = 'side-pin';
    pin.title = t('sidebar.pinned');
    pin.append(svg('pin'));
    titleRow.append(pin);
  }
  const title = document.createElement('strong');
  const rawTitle = rec.title && !isDefaultSessionTitle(rec.title) ? rec.title : t('sidebar.newChat');
  title.textContent = rawTitle;
  titleRow.append(title);
  const preview = document.createElement('span');
  preview.textContent = rec.preview || t('chat.noSummary');
  row.append(titleRow, preview);
  row.addEventListener('click', () => {
    closeSessionMenu();
    void attempt(() => launchChat('resume', { resumeSessionId: rec.sessionId }));
  });

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'side-session-more';
  more.setAttribute('aria-label', t('sidebar.sessionActions'));
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.append(svg('dots'));
  const openFromMore = () => {
    if (more.getAttribute('aria-expanded') === 'true') {
      closeSessionMenu();
      return;
    }
    const rect = more.getBoundingClientRect();
    openSessionMenu(rec, more, rect.left, rect.bottom + 4);
  };
  more.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    openFromMore();
  });
  const openFromPointer = (event: MouseEvent) => {
    event.preventDefault();
    openSessionMenu(rec, more, event.clientX, event.clientY);
  };
  row.addEventListener('contextmenu', openFromPointer);
  more.addEventListener('contextmenu', openFromPointer);
  const openFromKeyboard = (event: KeyboardEvent) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      openFromMore();
    }
  };
  row.addEventListener('keydown', openFromKeyboard);
  more.addEventListener('keydown', openFromKeyboard);

  wrap.append(row, more);
  return wrap;
}

let closeSessionMenu = (): void => {};

function sessionBusy(sessionId: string): boolean {
  return sessionId === chatSessionId && (chatState === 'starting' || chatState === 'generating' || chatState === 'waiting');
}

function clearOpenChat(): void {
  chatMessages = [];
  messageEls = new Map();
  chatSessionId = undefined;
  chatModel = undefined;
  lastUserText = undefined;
  latestFailedMessageId = undefined;
  pendingTitle = undefined;
  clearErrorHint();
  chatState = 'idle';
  noticeText = '';
  noticeRender = undefined;
}

async function finishSessionAction(): Promise<void> {
  await refreshSessions();
  if (page === 'history') render();
}

async function runSessionAction(sessionId: string, action: () => Promise<unknown>, removed = false): Promise<void> {
  try {
    if (removed && sessionBusy(sessionId)) {
      showMessage('ipc.busySessionDelete');
      return;
    }
    await action();
    if (removed && sessionId === chatSessionId) {
      clearOpenChat();
      page = 'chat';
      await refreshSessions();
      render();
      return;
    }
    await finishSessionAction();
  } catch (error) {
    message(error instanceof Error ? error.message : String(error));
  }
}

function openSessionMenu(rec: SessionRecord, more: HTMLButtonElement, x: number, y: number): void {
  closeSessionMenu();
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('sidebar.sessionMenu'));
  more.setAttribute('aria-expanded', 'true');

  const place = () => {
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };
  const focusItem = (index: number) => {
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    items[(index + items.length) % items.length].focus();
  };
  const menuItem = (label: string, action: () => void, danger = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-menu-item';
    if (danger) button.classList.add('is-danger');
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', event => {
      event.preventDefault();
      action();
    });
    return button;
  };
  const showRoot = () => {
    menu.replaceChildren(
      menuItem(rec.pinned ? t('sidebar.unpin') : t('sidebar.pin'), () => {
        closeSessionMenu();
        void runSessionAction(rec.sessionId, () => api.chatSetPinned(rec.sessionId, !rec.pinned));
      }),
      menuItem(t('sidebar.move'), () => showMove()),
      menuItem(t('sidebar.delete'), () => showConfirm(), true)
    );
    focusItem(0);
    place();
  };
  const showMove = () => {
    menu.replaceChildren();
    const others = (settings?.projects ?? []).filter(project => project.id !== rec.projectId);
    if (others.length === 0) {
      const note = document.createElement('p');
      note.className = 'session-menu-note';
      note.textContent = t('sidebar.noOtherProject');
      menu.append(note);
    } else {
      for (const project of others) {
        menu.append(menuItem(project.name, () => {
          closeSessionMenu();
          void runSessionAction(rec.sessionId, () => api.chatMove(rec.sessionId, project.id));
        }));
      }
    }
    menu.append(menuItem(t('sidebar.cancel'), () => showRoot()));
    focusItem(0);
    place();
  };
  const showConfirm = () => {
    if (sessionBusy(rec.sessionId)) {
      closeSessionMenu();
      showMessage('ipc.busySessionDelete');
      return;
    }
    menu.replaceChildren();
    const note = document.createElement('p');
    note.className = 'session-menu-note';
    note.textContent = t('sidebar.deleteConfirm');
    const actions = document.createElement('div');
    actions.className = 'session-menu-confirm';
    const cancel = menuItem(t('sidebar.cancel'), () => showRoot());
    const confirm = menuItem(t('sidebar.confirmDelete'), () => {
      closeSessionMenu();
      void runSessionAction(rec.sessionId, () => api.chatDelete(rec.sessionId), true);
    }, true);
    actions.append(cancel, confirm);
    menu.append(note, actions);
    cancel.focus();
    place();
  };
  const onKey = (event: KeyboardEvent) => {
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSessionMenu();
      more.focus();
    } else if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      focusItem(index + 1);
    } else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      focusItem(index <= 0 ? items.length - 1 : index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(items.length - 1);
    }
  };
  const onPointer = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && (menu.contains(target) || more.contains(target))) return;
    closeSessionMenu();
  };
  document.body.append(menu);
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onPointer, true);
  closeSessionMenu = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onPointer, true);
    more.setAttribute('aria-expanded', 'false');
    if (menu.isConnected) menu.remove();
    closeSessionMenu = () => {};
  };
  showRoot();
}

function paintSidebar(): void {
  closeSessionMenu();
  const host = document.getElementById('sideScroll');
  if (!host) return;
  host.replaceChildren();
  const project = activeProject();
  const projectHead = document.createElement('button');
  projectHead.type = 'button';
  projectHead.className = 'side-fold';
  projectHead.append(svg('folder'), document.createTextNode(project?.name ?? t('sidebar.unselectedProject')));
  host.append(projectHead);
  const mine = sessionRecords.filter(rec => !project || rec.projectId === project.id);
  const query = sideFilter.trim().toLowerCase();
  const matches = (rec: SessionRecord) => !query || `${rec.title} ${rec.preview}`.toLowerCase().includes(query);
  const projectList = document.createElement('div');
  projectList.className = 'side-group';
  const shown = mine.filter(matches).slice(0, 8);
  if (shown.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'side-empty';
    empty.textContent = project ? t('sidebar.projectNoChats') : t('sidebar.chooseProject');
    projectList.append(empty);
  } else {
    for (const rec of shown) projectList.append(sessionRow(rec));
  }
  host.append(projectList);
  const recentLabel = document.createElement('div');
  recentLabel.className = 'side-label';
  recentLabel.textContent = t('sidebar.recent');
  host.append(recentLabel);
  const recent = sessionRecords.filter(matches).slice(0, 12);
  if (recent.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'side-empty';
    empty.textContent = t('sidebar.noRecentChats');
    host.append(empty);
  } else {
    for (const rec of recent) host.append(sessionRow(rec));
  }
}

function beginRename(): void {
  const wrap = document.getElementById('titleEdit');
  if (!wrap) return;
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = displayTitle() === t('sidebar.newChat') ? '' : displayTitle();
  input.placeholder = t('sidebar.renameChatPlaceholder');
  input.maxLength = 80;
  wrap.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const title = input.value.replace(/\s+/g, ' ').trim();
    if (save && title) {
      pendingTitle = title;
      if (chatSessionId) {
        void api.chatRename(chatSessionId, title).then(updated => {
          pendingTitle = undefined;
          if (updated) rememberRecord(updated);
          paintTitle();
          paintSidebar();
        }).catch(error => {
          pendingTitle = undefined;
          paintTitle();
          message(error instanceof Error ? error.message : String(error));
        });
      } else {
        paintTitle();
      }
      return;
    }
    paintTitle();
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function applyModelChoice(name: string): void {
  let command: string;
  try { command = modelSlashCommand(name); }
  catch (error) {
    message(error instanceof Error ? error.message : String(error));
    return;
  }
  const selected = usableModel(name);
  if (deliverChat(command) && selected) {
    chatModel = selected;
    updateChatStatus();
  }
}

function sendChat(input: HTMLTextAreaElement): void {
  const text = input.value;
  const attachments = [...selectedAttachments];
  if (!text.trim() && attachments.length === 0) return;
  const failedDocx = attachments.find(item => item.extension === '.docx' && item.extractionStatus === 'error');
  if (failedDocx) {
    if (failedDocx.tooltipCode) message(t(failedDocx.tooltipCode, failedDocx.tooltipParams, locale));
    else showMessage('chat.copyAttachmentPrompt');
    return;
  }
  const prompt = buildPromptWithAttachments(text, attachments, locale);
  const sentKeys = new Set(attachments.map(item => attachmentPathKey(item.path)));
  const accepted = deliverChat(
    prompt,
    attachments.length > 0
      ? () => api.chatSend({ text, attachmentPaths: attachments.map(item => item.path) })
      : () => api.chatSend(text),
    undefined,
    () => {
      selectedAttachments = dedupeAttachments([...selectedAttachments, ...attachments]).slice(0, MAX_ATTACHMENTS);
      renderAttachmentChips();
    }
  );
  if (accepted) {
    selectedAttachments = selectedAttachments.filter(item => !sentKeys.has(attachmentPathKey(item.path)));
    renderAttachmentChips();
    input.value = '';
    chatDraft = '';
    autoResizeTextarea(input);
  }
}

function renderHistory(): void {
  const view = document.createElement('div');
  view.className = 'history-view';

  const head = document.createElement('div');
  head.className = 'history-head';

  const title = document.createElement('h2');
  title.textContent = t('history.title');

  const project = activeProject();
  const note = document.createElement('p');
  note.className = 'history-note';
  note.textContent = project
    ? t('history.projectNote', { name: project.name })
    : t('history.noProjectNote');

  const searchRow = document.createElement('div');
  searchRow.className = 'history-search-row';

  const search = document.createElement('input');
  search.className = 'history-search';
  search.type = 'search';
  search.placeholder = t('history.searchPlaceholder');
  search.setAttribute('aria-label', t('history.searchAria'));
  search.value = historySearchText;
  search.autocomplete = 'off';
  search.spellcheck = false;

  const countBadge = document.createElement('span');
  countBadge.className = 'history-count';

  searchRow.append(search, countBadge);
  head.append(title, note, searchRow);

  const list = document.createElement('div');
  list.className = 'history-list';

  view.append(head, list);
  content.append(view);

  if (!project) {
    list.append(historyEmpty(t('history.chooseProjectDescription'), t('history.goToProjects'), 'projects'));
    return;
  }

  let records: SessionRecord[] = [];
  const paint = () => {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const shown = records.filter(record => !query || `${record.title} ${record.preview} ${record.sessionId}`.toLowerCase().includes(query));

    countBadge.textContent = records.length ? t('history.count', { count: shown.length }) : '';

    if (records.length === 0) {
      list.append(historyEmpty(t('history.emptyProject'), t('history.openChat'), 'chat'));
      return;
    }
    if (shown.length === 0) {
      const p = document.createElement('p');
      p.className = 'history-note';
      p.textContent = t('history.noSearchResults');
      list.append(p);
      return;
    }
    for (const rec of shown) {
      list.append(historyCard(rec));
    }
  };

  search.addEventListener('input', () => {
    historySearchText = search.value;
    paint();
  });

  void api.chatList().then(all => {
    records = all.filter(record => record.projectId === project.id);
    paint();
  }).catch(error => {
    countBadge.textContent = '';
    const p = document.createElement('p');
    p.className = 'chat-error';
    p.textContent = t('history.readFailed', { error: error instanceof Error ? error.message : String(error) });
    list.append(p);
  });
}

function historyEmpty(text: string, action: string, target: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'chat-empty-container';
  const desc = document.createElement('div');
  desc.className = 'empty-desc';
  desc.textContent = text;
  box.append(desc, button(action, () => { page = target; render(); }));
  return box;
}

function historyCard(rec: SessionRecord): HTMLElement {
  const card = document.createElement('article');
  card.className = 'history-card';

  const info = document.createElement('div');
  info.className = 'history-info';

  const top = document.createElement('div');
  top.className = 'history-top';

  const heading = document.createElement('strong');
  heading.className = 'history-title';
  heading.textContent = localizedSessionTitle(rec.title);

  const time = document.createElement('span');
  time.className = 'history-time';
  time.textContent = Number.isNaN(Date.parse(rec.lastActiveAt)) ? rec.lastActiveAt : new Date(rec.lastActiveAt).toLocaleString(locale);

  top.append(heading, time);

  const preview = document.createElement('p');
  preview.className = 'history-preview';
  preview.textContent = rec.preview || t('chat.noSummary');

  const tags = document.createElement('div');
  tags.className = 'history-tags';

  const countTag = document.createElement('span');
  countTag.className = 'history-tag';
  countTag.textContent = t('history.messageCount', { count: rec.messageCount });
  tags.append(countTag);
  info.append(top, preview, tags);

  const restoreBtn = document.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'history-restore-btn';
  restoreBtn.textContent = t('history.restore');
  restoreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void attempt(() => launchChat('resume', { resumeSessionId: rec.sessionId }));
  });

  card.append(info, restoreBtn);
  card.addEventListener('click', () => {
    void attempt(() => launchChat('resume', { resumeSessionId: rec.sessionId }));
  });

  return card;
}

function render(): void {
  document.querySelectorAll('#sidebar [data-page]').forEach(item => {
    item.classList.toggle('active', (item as HTMLElement).dataset.page === page);
  });
  paintSidebar();
  if (page !== 'terminal') updateChatStatus();
  teardown();
  content.replaceChildren();
  content.classList.toggle('chat-mode', page === 'chat');
  content.dataset.page = page;

  if (page === 'projects') {
    const title = document.createElement('h2');
    title.textContent = t('projects.title');
    content.append(title, button(t('projects.addDirectory'), () => {
      void attempt(async () => { settings = await api.addProject(); });
    }));
    if (settings.projects.length === 0) {
      const p = document.createElement('p');
      p.textContent = t('projects.empty');
      content.append(p);
    }
    for (const project of settings.projects) {
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = `${project.name} · ${project.directory}`;
      row.append(
        name,
        button(settings.activeProjectId === project.id ? t('projects.current') : t('projects.select'), () => {
          void attempt(async () => { settings = await api.activateProject(project.id); });
        }, true),
        button(t('projects.remove'), () => {
          void attempt(async () => { settings = await api.removeProject(project.id); });
        }, true)
      );
      content.append(row);
    }
  } else if (page === 'settings') {
    const title = document.createElement('h2');
    title.textContent = t('settings.title');
    const languageRow = document.createElement('div');
    languageRow.className = 'language-setting';
    const languageLabel = document.createElement('label');
    languageLabel.htmlFor = 'languageSelect';
    languageLabel.textContent = t('settings.languageLabel');
    const languageSelect = document.createElement('select');
    languageSelect.id = 'languageSelect';
    languageSelect.setAttribute('aria-label', t('settings.languageLabel'));
    const chineseOption = document.createElement('option');
    chineseOption.value = 'zh-CN';
    chineseOption.textContent = t('settings.languageChinese');
    const englishOption = document.createElement('option');
    englishOption.value = 'en';
    englishOption.textContent = t('settings.languageEnglish');
    languageSelect.append(chineseOption, englishOption);
    languageSelect.value = locale;
    languageSelect.addEventListener('change', () => { void changeLanguage(languageSelect.value); });
    languageRow.append(languageLabel, languageSelect);
    const p = document.createElement('p');
    p.textContent = t('settings.cliPathNote', { path: settings.cliPath || t('settings.cliNotSelected') });
    const about = (document.getElementById('aboutTemplate') as HTMLTemplateElement).content.cloneNode(true) as DocumentFragment;
    about.querySelector('h3')!.textContent = t('settings.aboutTitle');
    about.querySelector('#aboutDisclaimer')!.textContent = t('disclaimer.full');
    content.append(title, languageRow, p, button(t('settings.selectCli'), () => {
      void attempt(async () => {
        settings = await api.selectCli();
        healthResult = undefined;
        healthExpanded = false;
        healthCollapsed = false;
        await refreshHealth();
      });
    }), about);
    renderHealthPanel(content, true);
  } else if (page === 'terminal') {
    const view = document.createElement('div');
    view.id = 'terminalView';
    const title = document.createElement('h2');
    title.id = 'terminalTitle';
    title.textContent = t('terminal.title');
    const info = document.createElement('p');
    info.id = 'terminalInfo';
    info.textContent = t('terminal.info');
    const controls = document.createElement('div');
    const start = button(t('terminal.start'), () => {
      if (terminal) void api.start(terminal.cols, terminal.rows).catch(error => message(error instanceof Error ? error.message : String(error)));
    });
    start.id = 'terminalStart';
    const stop = button(t('terminal.stop'), () => {
      void api.stop().catch(error => message(error instanceof Error ? error.message : String(error)));
    }, true);
    stop.id = 'terminalStop';
    controls.append(start, stop);
    const error = document.createElement('p');
    error.id = 'message';
    const host = document.createElement('div');
    host.id = 'terminal';
    view.append(title, info, controls, error, host);
    content.append(view);
    if (terminalExited) paintTerminalExitStatus();

    terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      theme: { background: '#0c1015' }
    });
    fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminal.onData(data => { if (active) api.write(data); });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
        const selection = terminal?.getSelection();
        if (selection) api.copy(selection);
        return false;
      }
      return true;
    });
    observer = new ResizeObserver(() => {
      fit?.fit();
      if (active && terminal) api.resize(terminal.cols, terminal.rows);
    });
    observer.observe(host);
    fit.fit();
  } else if (page === 'chat') {
    renderChat();
  } else if (page === 'history') {
    renderHistory();
  } else {
    const title = document.createElement('h2');
    title.textContent = t('terminal.unimplemented');
    content.append(title);
  }
}

function updateTerminalChrome(): void {
  const title = document.getElementById('terminalTitle');
  const info = document.getElementById('terminalInfo');
  const start = document.getElementById('terminalStart');
  const stop = document.getElementById('terminalStop');
  if (title) title.textContent = t('terminal.title');
  if (info) info.textContent = t('terminal.info');
  if (start) start.textContent = t('terminal.start');
  if (stop) stop.textContent = t('terminal.stop');
  if (!terminalExited) status.textContent = terminalRawStatus || t('status.idle');
}

function paintTerminalExitStatus(): void {
  status.textContent = typeof terminalExitCode === 'number'
    ? t('terminal.exited', { code: terminalExitCode })
    : t('terminal.exitedNoCode');
}

document.querySelectorAll('#sidebar [data-page]').forEach(item => item.addEventListener('click', () => {
  if (active && (item as HTMLElement).dataset.page !== 'terminal') {
    showMessage('terminal.stopBeforeLeaving');
    return;
  }
  page = (item as HTMLElement).dataset.page || 'chat';
  render();
}));
document.getElementById('languageQuick')?.addEventListener('click', () => {
  void changeLanguage(locale === 'zh-CN' ? 'en' : 'zh-CN');
});
document.getElementById('newChat')?.addEventListener('click', () => {
  void attempt(async () => { await launchChat('new'); });
});
document.getElementById('renameTitle')?.addEventListener('click', () => beginRename());
document.getElementById('chatTitle')?.addEventListener('click', () => beginRename());
document.getElementById('sideSearch')?.addEventListener('input', event => {
  sideFilter = (event.target as HTMLInputElement).value;
  paintSidebar();
});

api.onTerminal(event => {
  if (event.type === 'status') {
    terminalRawStatus = event.message ? `${event.state} · ${event.message}` : event.state;
    terminalExited = false;
    terminalExitCode = undefined;
    status.textContent = terminalRawStatus;
    active = event.state === 'active';
  }
  if (event.type === 'started') {
    active = true;
    terminal?.focus();
  }
  if (event.type === 'data') terminal?.write(event.data);
  if (event.type === 'error') message(event.message);
  if (event.type === 'exit') {
    active = false;
    terminalExited = true;
    terminalExitCode = event.exitCode;
    paintTerminalExitStatus();
  }
});

api.onChat(applyChatEvent);

function dressChrome(): void {
  const neu = document.getElementById('newChat');
  if (neu && !neu.querySelector('svg')) neu.prepend(svg('plus'));
  const search = document.querySelector('.side-search');
  if (search && !search.querySelector('svg')) search.prepend(svg('search'));
  const icons = [
    ['projects', 'folder'],
    ['terminal', 'terminal'],
    ['settings', 'gear'],
    ['history', 'search']
  ] as const;
  for (const [pageName, icon] of icons) {
    const button = document.querySelector(`#sidebar [data-page="${pageName}"]`);
    if (button && !button.querySelector('svg')) button.append(svg(icon));
  }
  const pencil = document.getElementById('renameTitle');
  if (pencil && !pencil.querySelector('svg')) pencil.append(svg('pencil'));
}
dressChrome();
document.getElementById('sideScroll')?.addEventListener('scroll', () => closeSessionMenu(), { passive: true });

function installFileDrop(): void {
  const keepWindow = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  window.addEventListener('dragenter', keepWindow);
  window.addEventListener('dragover', keepWindow);
  window.addEventListener('drop', event => {
    keepWindow(event);
    const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
    const paths: string[] = [];
    for (const file of files) {
      let filePath = '';
      try { filePath = api.pathForFile(file); } catch { filePath = ''; }
      if (filePath) paths.push(filePath);
    }
    if (paths.length === 0) {
      const listed = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '';
      for (const line of listed.split(/\r?\n/)) {
        const filePath = pathFromFileUri(line);
        if (filePath) paths.push(filePath);
      }
    }
    if (paths.length === 0) {
      if (files.length > 0) showMessage('chat.dropUnsupported');
      return;
    }
    void inspectAndAddAttachments(paths);
  });
}

async function maybeStartInitialChat(): Promise<void> {
  if (openedFreshChat || initialChatLaunchPending) return;
  initialChatLaunchPending = true;
  const ready = await api.chatReadiness().catch(() => null);
  if (ready?.configured && ready.sessionState === 'idle' && !openedFreshChat) {
    openedFreshChat = true;
    try { await launchChat('new'); }
    catch (error) { message(error instanceof Error ? error.message : String(error)); }
    render();
  }
  initialChatLaunchPending = false;
}

installFileDrop();

api.projects().then(async value => {
  settings = value;
  setLocale(value.language, false);
  try { sessionRecords = await api.chatList(); } catch { sessionRecords = []; }
  render();
  void maybeStartInitialChat();
  void refreshHealth().then(async () => {
    try { settings = await api.projects(); } catch { /* keep the current snapshot */ }
    await maybeStartInitialChat();
  });
}).catch(error => {
  content.textContent = t('app.settingsUnavailable', { productName: PRODUCT_SHORT_NAME, error: error.message });
});
