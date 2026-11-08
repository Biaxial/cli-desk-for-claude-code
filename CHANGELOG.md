# Changelog

## [0.1.1] - 2026-11-08

### 简体中文

- 调整界面间距、圆角、阴影和字号层级，并用纯 CSS 增加输入框生成态边光、思考指示和工具调用状态。未引入 React 或其他 UI 组件库。
- 最近聊天支持右键和行内菜单：删除、移动到其他项目、置顶。
- 欢迎空状态的标记改为 Claude 星标图标，不再使用空白渐变方块。

### English

- Refines spacing, radius, shadow, and type tokens, and adds a pure CSS composer border glow, thinking indicator, and tool-call status. No React or other UI component library.
- Recent chats support a right-click and row menu: delete, move to another project, and pin.
- The welcome empty-state mark uses the Claude asterisk icon instead of a blank gradient square.

## [0.1.0] - 2026-11-04

### 简体中文

CLI Desk for Claude Code 首个公开版本。

- 提供流式对话、Markdown 与代码块、工具调用状态、停止生成、模型切换，以及基于 xterm.js 的原生终端。
- 保存会话历史并支持恢复会话。
- 支持添加附件，并直接提取 Word `.docx` 文本。
- 提供可即时切换的简体中文和英文界面。
- 启动时检查 CLI 与版本、API base URL 配置状态及本地代理端口连通性。
- 按类别显示错误提示并支持重试。
- 提供 Windows 安装版与便携版；Linux 版本将在后续版本提供。
- 项目此前以工作名称「CC Desktop」开发；仍支持旧版 `CC_DESKTOP_USER_DATA` 变量和已有的旧版 userData 目录。

### English

First public release of CLI Desk for Claude Code.

- Adds streaming chat, Markdown and code blocks, tool-call status, stop generation, model switching, and a native xterm.js terminal.
- Saves session history and supports resuming conversations.
- Supports attachments, including direct text extraction from Word `.docx` files.
- Provides a Chinese and English UI with live language switching.
- Checks the CLI and its version, API base URL configuration, and local proxy port reachability at startup.
- Adds classified error guidance with retry.
- Provides Windows installer and portable builds; Linux builds will follow in a later release.
- The project was previously developed under the working name “CC Desktop”; the legacy `CC_DESKTOP_USER_DATA` variable and existing legacy userData directories remain supported.
