# CLI Desk for Claude Code

A desktop workspace that makes the Claude Code CLI easier to use.

[简体中文](#简体中文) · [English](#english)

> CLI Desk is an independent, unofficial third-party tool. It is not affiliated with, endorsed by, or sponsored by Anthropic. Built by Biaxial Studio.
>
> CLI Desk 是独立的非官方第三方工具，与 Anthropic 无关联，也未获其认可或赞助。由 Biaxial Studio 开发。

## 简体中文

### 项目初衷 / Why

Claude Code 桌面版需要 Anthropic 账号登录，封号风险大；CLI 接 API 可以避免这个问题，但 CLI 的使用体验又不如桌面版。所以我们把 CLI 包装成了桌面版，致力于提升 Claude Code CLI 的使用体验和易用性。目前只是初版，后期会更新更多合理适配。

### 功能

- 流式对话，支持 Markdown、代码块和代码复制。
- 展示工具调用状态；可随时停止生成。
- 保存会话历史，并可恢复已有会话。
- 在对话中切换可用模型。
- 添加多个附件；可直接提取 Word `.docx` 文本。PDF 和图片可由 Claude Code 根据其自身能力读取；其他附件类型可能只会传入文件路径。
- 简体中文与英文界面，可即时切换。
- 启动健康检查面板：检查 CLI 是否找到及其版本、API base URL 配置状态和本地代理端口连通性，可重新检查。
- 按类别提供错误说明和建议，并可重试。
- 原生终端模式使用 xterm.js 与 Claude Code CLI 交互。

### 截图

截图待补充。

<!-- ![对话窗口](docs/screenshots/chat.png) -->
<!-- ![原生终端](docs/screenshots/terminal.png) -->
<!-- ![设置页面](docs/screenshots/settings.png) -->

### 下载与安装

#### 1. 下载 CLI Desk

从 [GitHub Releases](https://github.com/jxy2336-bot/cli-desk-for-claude-code/releases) 下载适合系统的版本：

- Windows 安装版：`CLI-Desk-for-Claude-Code-Setup-0.1.0.exe`
- Windows 便携版：`CLI-Desk-for-Claude-Code-0.1.0-portable.exe`

v0.1.0 目前只提供 Windows 版本；Linux 版本正在适配中，将在后续版本发布。

Windows 版本目前未签名，SmartScreen 可能会显示警告。

#### 2. 安装 Claude Code CLI

先安装 Node.js 22 或更高版本，再运行官方 npm 安装命令（不要使用 sudo）：

```sh
npm install -g @anthropic-ai/claude-code
```

Anthropic 目前也推荐使用原生安装器：

- macOS、Linux 或 WSL：`curl -fsSL https://claude.ai/install.sh | bash`
- Windows PowerShell：`irm https://claude.ai/install.ps1 | iex`

安装说明见 [Claude Code 设置文档](https://code.claude.com/docs/en/setup)。安装完成后，打开一个新的终端窗口并运行 `claude --version` 确认 CLI 可用。

#### 3. 配置 API 提供方

在 Claude Code 设置文件中配置 API。文件位置：

- Windows：`%USERPROFILE%\.claude\settings.json`
- macOS 或 Linux：`~/.claude/settings.json`

将下面的内容合并到现有 JSON 中；不要覆盖掉其他已有设置：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.example.com",
    "ANTHROPIC_AUTH_TOKEN": "your-api-key-here",
    "ANTHROPIC_MODEL": "your-model-name"
  }
}
```

可以使用 Anthropic 官方 API，也可以使用兼容 Anthropic API 的第三方服务。CC Switch 等工具也可以管理提供方配置；这类工具通常会把 `ANTHROPIC_BASE_URL` 指向本机代理，例如 `http://127.0.0.1:15721`，使用时必须确保代理程序正在运行。

CLI Desk 不读取或显示 API token；健康检查只读取 base URL 配置。请勿提交或分享此设置文件。

#### 4. 首次启动

1. 启动 CLI Desk 并选择一个项目文件夹。
2. 如果在「设置」中指定了 CLI 路径，应用会使用该路径；未指定时才按默认位置查找，然后查 `PATH`。Windows 默认位置为 `%USERPROFILE%\.local\bin\claude.exe`。Linux 默认位置依次为 `~/.local/bin/claude`、`~/.npm-global/bin/claude`、`/usr/local/bin/claude` 和 `/usr/bin/claude`。
3. 健康检查面板会报告是否找到 CLI 及其版本、是否读取到 API base URL 配置，以及配置为本地地址时对应端口是否可访问。使用「重新检查」更新状态。
4. 首次运行时，界面语言跟随系统语言；之后可在「设置」中切换，也可使用侧栏快捷切换。

#### 5. 从源码构建

需要 Node.js 24 和 Git。在终端中运行：

```sh
git clone https://github.com/jxy2336-bot/cli-desk-for-claude-code.git
cd cli-desk-for-claude-code
npm ci
npm test
npm start
```

打包命令：

- `npm run dist`：在 Windows 上打包安装版和便携版；需要 Windows 随附的 .NET Framework 4 C# 编译器 `csc.exe`，用于构建 `NativeSupervisor.exe`。

构建产物写入 `release/`。如果 PowerShell 因“禁止运行脚本”而拦截 `npm.ps1`，请在 Windows PowerShell 中改用 `npm.cmd`，例如 `npm.cmd ci`、`npm.cmd test`、`npm.cmd start`。

应用数据默认保存在 Electron 的系统 appData 目录下、「CLI Desk for Claude Code」目录中（Windows 常见位置为 `%APPDATA%`，Linux 为 `~/.config`，macOS 为 `~/Library/Application Support`）。若检测到已有旧版数据目录，应用会继续使用该目录。设置 `CLI_DESK_USER_DATA` 可指定其他位置；旧变量 `CC_DESKTOP_USER_DATA` 仍受支持。数据包括应用设置、项目登记和会话历史。重置时先退出应用，按当前生效的位置找到 userData 目录，备份后再删除；设置了覆盖变量时，以变量指向的位置为准。

### 常见问题

- **提示 `ECONNREFUSED 127.0.0.1:<port>`：** 配置的本地代理（例如 CC Switch）没有运行，或 `ANTHROPIC_BASE_URL` 指向了错误的地址。启动代理或修正地址后重试。
- **找不到 CLI：** 确认已安装 Claude Code CLI；安装后打开新终端。检查 `PATH`，或在「设置」中选择 CLI 路径。
- **401 或 403：** 检查 API key/token 是否有效，以及提供方配置是否正确。
- **429：** 提供方已限流。稍后重试，或查看提供方的限额与用量设置。
- **找不到模型：** 检查 `ANTHROPIC_MODEL` 是否填写了该提供方支持的模型名称。
- **PowerShell 拦截 `npm.ps1`：** 使用 `npm.cmd` 运行 npm 命令。
- **Windows SmartScreen 警告：** Windows 构建目前未签名。
- **无法添加 `.doc` 文件：** 目前不支持旧版 Word `.doc` 格式，请先另存为 `.docx`。
- **如何清除应用数据：** 完全退出 CLI Desk 后，确定当前生效的 userData 目录：如果设置了 `CLI_DESK_USER_DATA` 或 `CC_DESKTOP_USER_DATA`，以对应变量为准；否则查看 Electron 的系统 appData 目录（应用可能会继续使用已有的旧版数据目录）。备份后删除该目录即可清除设置、项目登记和会话历史。

### 后续计划

v0.1.0 是首个版本，后续会继续做更合理的适配，例如 macOS 构建、对话中写入类工具的权限提示、支持更多附件格式以及代码签名。欢迎贡献。

### 免责声明

CLI Desk 是独立的非官方第三方工具，与 Anthropic 无关联，也未获 Anthropic 认可、背书或赞助。「Claude」和「Claude Code」是 Anthropic, PBC 的商标。用户应遵守所使用的 API 提供方条款。

### 许可证

本项目采用 MIT 许可证。Copyright (c) 2026 Biaxial Studio。详情见 [LICENSE](LICENSE)。

## English

### Why this project

The Claude Code desktop app requires signing in with an Anthropic account, which carries a high risk of the account being banned. Connecting the CLI to an API avoids this problem, but the CLI experience is not as good as the desktop app. So we wrapped the CLI in a desktop app, aiming to make the Claude Code CLI more pleasant and easier to use. This is an early first version, and more sensible adaptations will follow.

### Features

- Streaming chat with Markdown, code blocks, and code copying.
- Tool-call status display and the ability to stop generation.
- Session history with the ability to resume a saved session.
- Switch between available models in chat.
- Add multiple attachments, including direct text extraction from Word `.docx` files. Claude Code may read PDFs and images using its own capabilities; other attachment types may pass only their file paths.
- Chinese and English UI with instant language switching.
- A startup health-check panel that reports whether the CLI was found and its version, whether an API base URL is configured, and whether a configured local proxy port is reachable. You can recheck at any time.
- Classified error guidance with a retry action.
- A native terminal mode powered by xterm.js for working with the Claude Code CLI.

### Screenshots

Screenshots coming soon.

<!-- ![Chat window](docs/screenshots/chat.png) -->
<!-- ![Native terminal](docs/screenshots/terminal.png) -->
<!-- ![Settings](docs/screenshots/settings.png) -->

### Download and setup

#### 1. Download CLI Desk

Download the build for your platform from [GitHub Releases](https://github.com/jxy2336-bot/cli-desk-for-claude-code/releases):

- Windows installer: `CLI-Desk-for-Claude-Code-Setup-0.1.0.exe`
- Windows portable build: `CLI-Desk-for-Claude-Code-0.1.0-portable.exe`

v0.1.0 ships for Windows only; Linux support is in progress and will arrive in a later release.

The Windows builds are unsigned, so SmartScreen may show a warning.

#### 2. Install Claude Code CLI

Install Node.js 22 or later, then run the official npm command (do not use sudo):

```sh
npm install -g @anthropic-ai/claude-code
```

Anthropic also currently recommends its native installer:

- macOS, Linux, or WSL: `curl -fsSL https://claude.ai/install.sh | bash`
- Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`

See the [Claude Code setup documentation](https://code.claude.com/docs/en/setup). After installation, open a **new terminal** and run `claude --version` to verify the CLI.

#### 3. Configure an API provider

Configure the API in the Claude Code settings file:

- Windows: `%USERPROFILE%\.claude\settings.json`
- macOS or Linux: `~/.claude/settings.json`

Merge this example into the existing JSON instead of replacing other settings:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.example.com",
    "ANTHROPIC_AUTH_TOKEN": "your-api-key-here",
    "ANTHROPIC_MODEL": "your-model-name"
  }
}
```

You can use the official Anthropic API or any third-party provider with an Anthropic-compatible endpoint. Tools such as CC Switch can manage provider settings. They often point `ANTHROPIC_BASE_URL` to a local proxy such as `http://127.0.0.1:15721`; that proxy must be running while you use it.

CLI Desk does not read or display the API token. The health check reads only the base URL configuration. Never commit or share this settings file.

#### 4. First launch

1. Start CLI Desk and choose a project folder.
2. If a CLI path is configured in Settings, the app uses that path. Otherwise, it checks the platform defaults and then `PATH`. The Windows default is `%USERPROFILE%\.local\bin\claude.exe`. Linux defaults are checked in this order: `~/.local/bin/claude`, `~/.npm-global/bin/claude`, `/usr/local/bin/claude`, and `/usr/bin/claude`.
3. The health-check panel reports whether the CLI was found and its version, whether an API base URL is configured, and whether a local endpoint's port is reachable. Use **Recheck** to refresh the status.
4. On first run, the UI follows the system language. You can switch languages in Settings or with the sidebar shortcut.

#### 5. Build from source

You need Node.js 24 and Git. Run:

```sh
git clone https://github.com/jxy2336-bot/cli-desk-for-claude-code.git
cd cli-desk-for-claude-code
npm ci
npm test
npm start
```

Packaging commands:

- `npm run dist` builds the Windows installer and portable build on Windows. It needs the .NET Framework 4 C# compiler `csc.exe` that ships with Windows to build `NativeSupervisor.exe`.

Build output goes to `release/`. If PowerShell blocks `npm.ps1` because script execution is disabled, use `npm.cmd` instead, for example `npm.cmd ci`, `npm.cmd test`, and `npm.cmd start`.

By default, app data is stored in Electron's system appData directory under “CLI Desk for Claude Code” (commonly `%APPDATA%` on Windows, `~/.config` on Linux, and `~/Library/Application Support` on macOS). If an existing legacy data directory is found, the app continues to use it. Set `CLI_DESK_USER_DATA` to choose another location; the legacy `CC_DESKTOP_USER_DATA` variable is also supported. App data includes settings, project registrations, and session history. To reset it, quit the app, identify the active userData directory, back it up, and remove it. If an override variable is set, use its configured location.

### FAQ and troubleshooting

- **`ECONNREFUSED 127.0.0.1:<port>`:** A configured local proxy such as CC Switch may not be running, or `ANTHROPIC_BASE_URL` may point to the wrong address. Start the proxy or fix the URL, then retry.
- **CLI not found:** Install Claude Code CLI and open a new terminal. Check `PATH` or set the CLI path in Settings.
- **401 or 403:** Check that the API key/token is valid and that the provider settings are correct.
- **429:** The provider is rate limiting requests. Retry later or check its quota and usage limits.
- **Model not found:** Check that `ANTHROPIC_MODEL` matches a model name supported by your provider.
- **PowerShell blocks `npm.ps1`:** Run npm commands through `npm.cmd`.
- **Windows SmartScreen warning:** The Windows builds are currently unsigned.
- **Cannot attach `.doc`:** The older Word `.doc` format is not supported. Save the document as `.docx` and attach it again.
- **Resetting app data:** Quit CLI Desk completely and identify the active userData directory. If `CLI_DESK_USER_DATA` or `CC_DESKTOP_USER_DATA` is set, use the directory named by that variable; otherwise check Electron's system appData directory (the app may continue using an existing legacy directory). Back it up, then remove it to clear settings, project registrations, and session history.

### Roadmap

v0.1.0 is the first release. More considered adaptations are planned, including a macOS build, permission prompts for write tools in chat, additional attachment formats, and code signing. Contributions are welcome.

### Disclaimer

CLI Desk is an independent, unofficial third-party tool. It is not affiliated with, endorsed by, or sponsored by Anthropic. “Claude” and “Claude Code” are trademarks of Anthropic, PBC. Users are responsible for following the terms of their API provider.

### License

This project is licensed under the MIT License. Copyright (c) 2026 Biaxial Studio. See [LICENSE](LICENSE).

## Project structure

- `src/main` — Electron main process, CLI integration, chat, health checks, and persistence.
- `src/renderer` — application UI, including the chat workspace and xterm.js terminal.
- `src/preload` — the restricted bridge between the UI and main process.
- `src/shared` — shared types, localization, attachment handling, and error classification.
- `src/native/windows` — Windows process supervisor implementation.
- `tests` — unit and integration tests.
- `scripts` — build, launch, and packaging helpers.

