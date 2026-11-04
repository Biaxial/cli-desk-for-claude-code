# M02 — Chat workspace architecture

## Decision 1: Use the CLI's structured stream protocol

Graphical chat communicates with Claude Code using the CLI's `stream-json` input and output formats. It consumes structured events for session initialization, message and content-block updates, tool calls, and results rather than parsing terminal output.

The CLI may emit its initialization event only after the first user message. The chat coordinator therefore accepts the first send after the process has spawned and records the native session ID when initialization arrives.

## Decision 2: Share project process coordination with terminal mode

Graphical chat and native terminal mode use the same platform supervisor and project lock. Chat runs the CLI through pipes so the structured stream remains plain text; terminal mode uses a PTY. The project lock prevents the two modes from launching competing CLI processes in the same project at the same time.

Windows uses `NativeSupervisor.exe`. On Linux and macOS, a Node-based supervisor using a lock file and process group replaces it.

## Decision 3: Present one assistant reply per user turn

The workspace combines streaming text into one assistant reply for each user turn. Tool calls appear inline with their status, and thinking activity is represented as a status rather than part of the visible conversation transcript.

## Decision 4: Index sessions by the native Claude Code session ID

The app stores session metadata and visible conversation history in its own user-data directory, keyed by the native `session_id` emitted by Claude Code. Resuming a saved conversation passes that ID to the CLI and restores the saved transcript. The app does not invent or substitute a session ID.

## Decision 5: Preserve provider configuration for the CLI

The chat helper removes environment variables that mark a nested Claude Code session, while preserving the provider configuration needed by the CLI, including `ANTHROPIC_*` values. The API token is consumed by the CLI; the health check reads only the base URL configuration.

## Scope

The workspace focuses on chat, session history, attachments, model selection, and status feedback. CLI Desk does not provide its own plugin, MCP, Skills, or Hooks execution system; those capabilities remain part of the CLI's existing configuration and behavior.

