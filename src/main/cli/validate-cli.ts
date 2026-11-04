import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { t, type Locale, type TranslationKey } from '../../shared/i18n';

export type CliValidationKind = 'not-found' | 'start-error' | 'signal' | 'timeout' | 'non-zero-exit';

export type CliDiagnostic = {
  cliPath: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  stdout: string;
  stderr: string;
};

export class CliValidationError extends Error {
  readonly kind: CliValidationKind;
  readonly diagnostic: CliDiagnostic;
  readonly code: TranslationKey;
  readonly params: Record<string, string | number>;
  constructor(kind: CliValidationKind, code: TranslationKey, params: Record<string, string | number>, diagnostic: CliDiagnostic, locale: Locale = 'zh-CN') {
    super(t(code, params, locale));
    this.name = 'CliValidationError';
    this.kind = kind;
    this.diagnostic = diagnostic;
    this.code = code;
    this.params = params;
  }
}

function summarize(text: string | null | undefined, max = 200): string {
  if (!text) return '';
  const clean = text.replace(/\r/g, '').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

/** Windows cmd.exe treats a leading UTF-8 BOM as part of the first command (`﻿@echo`). */
export function hasUtf8Bom(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const header = Buffer.alloc(3);
    const read = readSync(fd, header, 0, 3, 0);
    return read >= 3 && header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

export const CMD_BOM_MESSAGE = t('cli.error.bom', {}, 'zh-CN');

/** Preserve the command's own argument quotes through cmd.exe /s /c parsing. */
export function quoteWindowsCmdCommand(command: string): string {
  return `"${command}"`;
}

export function validateCliPath(value: string, timeoutMs = 10000): string {
  const cleaned = value.replace(/^\uFEFF/, '').trim();
  const diagnostic: CliDiagnostic = { cliPath: cleaned, durationMs: 0, exitCode: null, signal: null, errorCode: null, errorMessage: null, stdout: '', stderr: '' };
  if (!path.isAbsolute(cleaned)) throw new CliValidationError('not-found', 'cli.error.notAbsolute', {}, diagnostic);
  if (!existsSync(cleaned)) throw new CliValidationError('not-found', 'cli.error.notFound', {}, diagnostic);
  if (!statSync(cleaned).isFile()) throw new CliValidationError('not-found', 'cli.error.notFile', {}, diagnostic);
  if (!/\.(exe|cmd)$/i.test(cleaned)) throw new CliValidationError('not-found', 'cli.error.unsupported', {}, diagnostic);
  if (cleaned.toLowerCase().endsWith('.cmd') && hasUtf8Bom(cleaned)) {
    throw new CliValidationError('start-error', 'cli.error.bom', {}, diagnostic);
  }
  value = cleaned;

  const executable = value.toLowerCase().endsWith('.cmd') ? process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : value;
  const isCmd = executable !== value;
  const args = isCmd ? ['/d', '/s', '/c', quoteWindowsCmdCommand(`"${value}" --version`)] : ['--version'];

  const started = Date.now();
  const probe = spawnSync(executable, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: isCmd });
  const spawnError = probe.error as (NodeJS.ErrnoException & { code?: string }) | undefined;
  diagnostic.durationMs = Date.now() - started;
  diagnostic.exitCode = probe.status;
  diagnostic.signal = probe.signal ?? null;
  diagnostic.errorCode = spawnError?.code ?? null;
  diagnostic.errorMessage = spawnError?.message ?? null;
  diagnostic.stdout = summarize(probe.stdout);
  diagnostic.stderr = summarize(probe.stderr);

  if (spawnError) {
    if (spawnError.code === 'ETIMEDOUT') {
      throw new CliValidationError('timeout', 'cli.error.timeout', { durationMs: Math.round(diagnostic.durationMs) }, diagnostic);
    }
    throw new CliValidationError('start-error', 'cli.error.start', { reason: spawnError.code ?? spawnError.message }, diagnostic);
  }
  if (probe.signal) {
    throw new CliValidationError('signal', 'cli.error.signal', { signal: probe.signal }, diagnostic);
  }
  if (probe.status !== 0) {
    const codeText = typeof probe.status === 'number'
      ? t('cli.error.nonZeroCode', { code: probe.status }, 'zh-CN')
      : t('cli.error.noCode', {}, 'zh-CN');
    throw new CliValidationError('non-zero-exit', 'cli.error.exit', { codeText }, diagnostic);
  }
  return cleaned;
}
