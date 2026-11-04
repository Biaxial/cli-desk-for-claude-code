# Changelog

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
