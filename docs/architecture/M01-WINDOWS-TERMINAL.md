# M01 — Native terminal architecture

## Overview

The native terminal mode embeds xterm.js in the renderer and connects it to a pseudo-terminal running the configured Claude Code CLI. The renderer handles terminal input, output, sizing, and copy behavior; process management stays in the Electron main process and helper processes.

## Process lifecycle

The main process starts a platform supervisor for a project session. The supervisor starts a PTY helper, which launches the CLI in the selected project directory and forwards terminal data over a newline-framed JSON protocol. Terminal dimensions are validated before they are sent to the PTY.

A project lock prevents the terminal and graphical chat from starting competing CLI processes for the same project. Stop, normal exit, startup failure, and an already-held lock are reported as separate states. Closing a session releases its owned process tree; the application does not terminate unrelated processes by name.

On Windows, `NativeSupervisor.exe` uses a named OS mutex for the project lock and a Job Object configured to close owned child processes when the supervisor exits. The helper is assigned to the Job before it is allowed to create the PTY.

On Linux and macOS, a Node-based supervisor uses a lock file and process group in place of `NativeSupervisor.exe`.

## Data boundaries

The application stores project registrations, the configured CLI path, and related app data in Electron's `userData` directory. Claude Code continues to use its configured CLI settings and authentication. CLI Desk does not copy or manage Claude Code credentials, sessions, Skills, Hooks, or MCP configuration.

## Constraints

The terminal protocol uses newline-delimited JSON and bounds received message size. The renderer receives a limited preload API rather than filesystem or process-management primitives.

