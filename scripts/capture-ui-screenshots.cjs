const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const outputDir = process.env.CC_UI_SHOTS || path.join(__dirname, '..', '.ui-shots');
fs.mkdirSync(outputDir, { recursive: true });

app.whenReady().then(async () => {
  const giveUp = setTimeout(() => { console.error('capture timed out'); app.exit(1); }, 20000);
  const win = new BrowserWindow({
    width: 1160,
    height: 760,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../dist/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  const mockSettings = {
    schemaVersion: 1,
    cliPath: '/fake/bin/claude',
    activeProjectId: 'proj-1',
    projects: [{ id: 'proj-1', name: 'demo-project', directory: '/home/user/demo-project', lastOpenedAt: new Date().toISOString() }]
  };

  const mockSessions = [
    {
      sessionId: 'sess-8f3a9b1c-2234',
      projectId: 'proj-1',
      projectDirectory: '/home/user/demo-project',
      title: '重构图形对话渲染器与状态管理',
      preview: '已完成 CSS 架构重构，将聊天卡片布局对齐现代 AI 桌面客户端，支持代码块一键复制与折叠思考。',
      messageCount: 4,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      lastActiveAt: new Date(Date.now() - 1800000).toISOString()
    },
    {
      sessionId: 'sess-1a2b3c4d-5678',
      projectId: 'proj-1',
      projectDirectory: '/home/user/demo-project',
      title: '排查多进程互斥锁与超时看门狗',
      preview: '验证了 Windows NativeSupervisor 崩溃退出后句柄与锁的释放逻辑，单元测试全部通过。',
      messageCount: 6,
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      lastActiveAt: new Date(Date.now() - 72000000).toISOString()
    }
  ];

  let currentChatState = 'idle';
  let currentSessionId = undefined;
  let chatMessagesMap = {
    'sess-8f3a9b1c-2234': [
      {
        id: 'msg-u1',
        role: 'user',
        blocks: [{ type: 'text', text: '请帮我实现 Codex 风格的聊天界面，需要支持用户与助手气泡区分、折叠思考和代码块复制。' }],
        state: 'complete',
        createdAt: new Date(Date.now() - 1800000).toISOString()
      },
      {
        id: 'msg-a1',
        role: 'assistant',
        blocks: [
          { type: 'thinking', thinking: '分析用户需求：1. 气泡区分 2. 思考过程折叠 3. 代码复制\n采用现代深色主题与独立气泡样式。' },
          { type: 'tool_use', name: 'ReadFile', input: '{"path":"src/renderer/index.html"}' },
          { type: 'text', text: '我已经为您完成了 Codex 风格的界面改造！\n\n### 核心升级点：\n- **清晰角色区分**：用户气泡与助手卡片具有高对比度深色调及圆角布局；\n- **思考过程折叠**：内部推理被收纳在 `思考过程` 折叠栏中，默认不干扰阅读；\n- **代码块一键复制**：代码区域拥有专属顶栏与复制按钮。\n\n```typescript\n// 示例：状态芯片状态映射\nconst statusLabel: Record<ChatState, string> = {\n  idle: "空闲",\n  generating: "正在生成",\n  completed: "已完成"\n};\n```\n\n请问接下来需要调整历史会话的搜索或过滤功能吗？' }
        ],
        state: 'complete',
        model: 'claude-3-7-sonnet',
        createdAt: new Date(Date.now() - 1700000).toISOString()
      }
    ]
  };

  ipcMain.handle('projects:list', () => mockSettings);
  ipcMain.handle('chat:readiness', () => ({ configured: true, missing: null, hasProject: true, hasCli: true, sessionState: currentChatState, sessionId: currentSessionId }));
  ipcMain.handle('chat:list', () => mockSessions);
  ipcMain.handle('chat:status', () => ({ state: currentChatState, sessionId: currentSessionId }));
  ipcMain.handle('chat:messages', (e, id) => chatMessagesMap[id] || []);
  ipcMain.handle('chat:stop', () => { currentChatState = 'interrupted'; return { state: 'interrupted' }; });
  ipcMain.handle('chat:send', (e, text) => { currentChatState = 'generating'; return { state: 'generating' }; });
  ipcMain.handle('chat:start', (e, launch) => {
    if (launch && launch.resumeSessionId) {
      currentSessionId = launch.resumeSessionId;
      const msgs = chatMessagesMap[launch.resumeSessionId] || [];
      return { state: 'idle', sessionId: currentSessionId, messages: msgs };
    }
    if (launch && launch.continueLatest) {
      currentSessionId = mockSessions[0].sessionId;
      const msgs = chatMessagesMap[currentSessionId] || [];
      return { state: 'idle', sessionId: currentSessionId, messages: msgs };
    }
    currentSessionId = undefined;
    return { state: 'idle', messages: [] };
  });
  ipcMain.on('terminal:copy', (e, text) => {});

  await win.loadFile(path.join(__dirname, '../dist/renderer/index.html'));
  await new Promise(r => setTimeout(r, 600));

  // 1. Capture Empty Chat
  const emptyImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, 'empty-chat.png'), emptyImg.toPNG());
  console.log('1. Captured empty-chat.png');

  // 2. Simulate Active Streaming
  win.webContents.send('chat:event', {
    type: 'user_message',
    message: {
      id: 'msg-u-stream',
      role: 'user',
      blocks: [{ type: 'text', text: '请帮我写一个 TypeScript 的互斥锁实现。' }],
      state: 'complete',
      createdAt: new Date().toISOString()
    }
  });
  win.webContents.send('chat:event', {
    type: 'state',
    state: 'generating'
  });
  win.webContents.send('chat:event', {
    type: 'assistant_start',
    messageId: 'msg-a-stream',
    model: 'claude-3-7-sonnet'
  });
  win.webContents.send('chat:event', {
    type: 'thinking_delta',
    messageId: 'msg-a-stream',
    text: '正在规划互斥锁的数据结构：Promise 链式排队机制与 release 回调设计...'
  });
  win.webContents.send('chat:event', {
    type: 'text_delta',
    messageId: 'msg-a-stream',
    text: '这里是一个轻量级且健壮的异步互斥锁（AsyncMutex）实现：\n\n```typescript\nexport class AsyncMutex {\n  private _locked = false;\n  private _queue: (() => void)[] = [];\n'
  });
  await new Promise(r => setTimeout(r, 400));
  const streamingImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, 'active-streaming.png'), streamingImg.toPNG());
  console.log('2. Captured active-streaming.png');

  // 3. Complete the turn (Completed multi-turn)
  win.webContents.send('chat:event', {
    type: 'text_delta',
    messageId: 'msg-a-stream',
    text: '\n  async acquire(): Promise<() => void> {\n    if (!this._locked) {\n      this._locked = true;\n      return () => this.release();\n    }\n    return new Promise(resolve => {\n      this._queue.push(() => resolve(() => this.release()));\n    });\n  }\n\n  private release(): void {\n    const next = this._queue.shift();\n    if (next) next();\n    else this._locked = false;\n  }\n}\n```\n\n使用方法：\n```typescript\nconst unlock = await mutex.acquire();\ntry {\n  // 临界区代码\n} finally {\n  unlock();\n}\n```'
  });
  win.webContents.send('chat:event', {
    type: 'turn_complete',
    messageId: 'msg-a-stream',
    result: 'OK',
    isError: false
  });
  await new Promise(r => setTimeout(r, 400));
  const completedImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, 'completed-multi-turn.png'), completedImg.toPNG());
  console.log('3. Captured completed-multi-turn.png');

  // 4. Capture History page, then a search that keeps one row
  await win.webContents.executeJavaScript(`
    document.querySelector('nav button[data-page="history"]').click();
  `);
  await new Promise(r => setTimeout(r, 500));
  const historyImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, 'history-list.png'), historyImg.toPNG());
  console.log('4. Captured history-list.png');

  const filtered = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.history-search');
    if (!input) return 'missing-search';
    input.value = '互斥';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return String(document.querySelectorAll('.history-card').length);
  })()`);
  console.log('history filter rows:', filtered);
  await new Promise(r => setTimeout(r, 200));
  const searchImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, 'history-search.png'), searchImg.toPNG());
  console.log('4b. Captured history-search.png');
  // Re-enter history so the search field resets before restore. The seeded
  // transcript belongs to the first row, not the filtered mutex row.
  const reset = await win.webContents.executeJavaScript(`(() => {
    try {
      document.querySelector('nav button[data-page="history"]').click();
      return 'reset';
    } catch (error) {
      return 'error:' + (error && error.message);
    }
  })()`);
  console.log('history reset:', reset);
  await new Promise(r => setTimeout(r, 250));

  // 5. Restore session from history (Restored session with both roles visible)
  const restored = await win.webContents.executeJavaScript(`(() => {
    try {
      const button = document.querySelector('.history-restore-btn');
      if (!button) return 'missing-restore';
      button.click();
      return 'clicked';
    } catch (error) {
      return 'error:' + (error && error.message);
    }
  })()`);
  console.log('restore:', restored);
  await new Promise(r => setTimeout(r, 400));
  // The live view sticks to the latest turn. Scroll up so the seeded user bubble is in frame.
  const scrolled = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('.chat-list');
    if (!list) return 'no-list';
    list.style.overflowAnchor = 'none';
    list.scrollTop = 0;
    return JSON.stringify({ top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight, msgs: document.querySelectorAll('.msg').length });
  })()`);
  console.log('transcript scroll:', scrolled);
  await new Promise(r => setTimeout(r, 200));
  const again = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('.chat-list');
    list.scrollTop = 0;
    return JSON.stringify({ top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight });
  })()`);
  console.log('transcript scroll again:', again);
  const restoredImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, 'restored-session.png'), restoredImg.toPNG());
  console.log('5. Captured restored-session.png');

  console.log('All 5 states verified and captured successfully!');
  clearTimeout(giveUp);
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
