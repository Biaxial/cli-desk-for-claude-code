import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ErrorContext, localEndpoint, redactUrl } from '../../shared/error-hints';

/**
 * Reads only the API base URL from the Claude CLI user settings. Tokens and keys in the
 * same file are never returned, logged or displayed.
 */
export type BaseUrlInfo = {
  /** Redacted URL, or undefined when no custom base URL is configured. */
  baseUrl?: string;
  source: 'settings' | 'environment' | 'none';
  settingsPath: string;
  settingsFound: boolean;
  /** settings.json exists but is not valid JSON. */
  settingsInvalid: boolean;
  local?: { host: string; port: number };
};

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  if (custom && path.isAbsolute(custom)) return custom;
  return path.join(home, '.claude');
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(claudeConfigDir(env, home), 'settings.json');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readBaseUrl(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): BaseUrlInfo {
  const settingsPath = claudeSettingsPath(env, home);
  let settingsFound = false;
  let settingsInvalid = false;
  let fromSettings: string | undefined;
  try {
    const text = readFileSync(settingsPath, 'utf8');
    settingsFound = true;
    try {
      const data: unknown = JSON.parse(stripBom(text));
      const envBlock = data && typeof data === 'object' ? (data as { env?: unknown }).env : undefined;
      const value = envBlock && typeof envBlock === 'object' ? (envBlock as Record<string, unknown>).ANTHROPIC_BASE_URL : undefined;
      if (typeof value === 'string' && value.trim()) fromSettings = value.trim();
    } catch { settingsInvalid = true; }
  } catch { /* no settings file */ }
  const fromEnv = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  // Claude Code applies settings.json env on top of the inherited environment.
  const chosen = fromSettings ?? fromEnv;
  const source: BaseUrlInfo['source'] = fromSettings ? 'settings' : (fromEnv ? 'environment' : 'none');
  const baseUrl = chosen ? redactUrl(chosen) : undefined;
  return { baseUrl, source, settingsPath, settingsFound, settingsInvalid, local: localEndpoint(chosen) };
}

/** True when something accepts a TCP connection on host:port within timeoutMs. */
export function isPortListening(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Facts the error classifier needs. Never includes a token. */
export async function errorContext(info: BaseUrlInfo = readBaseUrl()): Promise<ErrorContext> {
  if (!info.baseUrl) return {};
  if (!info.local) return { baseUrl: info.baseUrl, baseUrlIsLocal: false };
  const listening = await isPortListening(info.local.host, info.local.port);
  return { baseUrl: info.baseUrl, baseUrlIsLocal: true, baseUrlListening: listening };
}
