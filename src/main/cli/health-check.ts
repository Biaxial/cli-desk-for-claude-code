import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasUtf8Bom, quoteWindowsCmdCommand } from './validate-cli';
import { BaseUrlInfo, isPortListening, readBaseUrl } from './claude-settings';
import type { HealthCheckResult, HealthCheckRow, HealthStatus } from '../../shared/contracts';

export type CliCandidateSource = 'settings' | 'default' | 'path';
export type CliCandidate = { path: string; source: CliCandidateSource };

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const found = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
  return found ? env[found] : undefined;
}

/** Build candidates in preference order, using win32 path rules when modeling Windows. */
export function buildCliCandidates(
  platform: NodeJS.Platform | 'win32',
  home: string,
  env: NodeJS.ProcessEnv,
  configuredPath?: string | null
): CliCandidate[] {
  const configured = configuredPath?.trim();
  if (configured) return [{ path: configured, source: 'settings' }];

  const paths = platform === 'win32' ? path.win32 : path;
  const candidates: CliCandidate[] = [];
  if (platform === 'win32') {
    candidates.push({ path: path.win32.join(home, '.local', 'bin', 'claude.exe'), source: 'default' });
  }

  const pathValue = envValue(env, 'PATH') ?? '';
  const pathEntries = pathValue.split(paths.delimiter).filter(entry => entry.length > 0);
  if (platform === 'win32') {
    const configuredPathExt = envValue(env, 'PATHEXT');
    const effectiveExtensions = configuredPathExt === undefined
      ? ['.exe', '.cmd', '.bat']
      : configuredPathExt.split(';')
        .map(extension => extension.trim().toLowerCase())
        .filter(extension => ['.exe', '.cmd', '.bat'].includes(extension));
    for (const directory of pathEntries) {
      for (const extension of effectiveExtensions) {
        candidates.push({ path: paths.resolve(directory, `claude${extension}`), source: 'path' });
      }
    }
  } else {
    for (const directory of pathEntries) candidates.push({ path: paths.resolve(directory, 'claude'), source: 'path' });
  }
  return candidates;
}

export function findCliPath(
  platform: NodeJS.Platform | 'win32',
  home: string,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean = existsSync,
  configuredPath?: string | null
): { cliPath?: string; source: CliCandidateSource | 'missing'; configuredPath?: string } {
  const candidates = buildCliCandidates(platform, home, env, configuredPath);
  if (configuredPath?.trim()) {
    const candidate = candidates[0];
    return exists(candidate.path)
      ? { cliPath: candidate.path, source: candidate.source }
      : { source: 'missing', configuredPath: candidate.path };
  }
  const defaultCandidate = candidates.find(candidate => candidate.source === 'default');
  if (defaultCandidate && exists(defaultCandidate.path)) return { cliPath: defaultCandidate.path, source: 'default' };
  const pathCandidate = candidates.find(candidate => candidate.source === 'path' && exists(candidate.path));
  return pathCandidate ? { cliPath: pathCandidate.path, source: 'path' } : { source: 'missing' };
}

/** Extract only a recognizable version string; never surface arbitrary CLI output. */
export function parseCliVersion(output: string): string | undefined {
  const clean = output.replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  const expression = /^(?:Claude Code\s+)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\s*\(Claude Code\))?$/i;
  return clean.split('\n').map(line => line.trim()).find(line => expression.test(line));
}

export function versionCommand(cliPath: string, platform: NodeJS.Platform | 'win32', env: NodeJS.ProcessEnv): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const extension = path.win32.extname(cliPath).toLowerCase();
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const comSpec = envValue(env, 'ComSpec') || path.win32.join(envValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe');
    return { file: comSpec, args: ['/d', '/s', '/c', quoteWindowsCmdCommand(`"${cliPath}" --version`)], windowsVerbatimArguments: true };
  }
  return { file: cliPath, args: ['--version'] };
}

function runVersion(cliPath: string, platform: NodeJS.Platform | 'win32', env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ ok: boolean; output?: string; timedOut?: boolean }> {
  const command = versionCommand(cliPath, platform, env);
  return new Promise(resolve => {
    execFile(command.file, command.args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      env,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    }, (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        resolve({ ok: false, timedOut: code === 'ETIMEDOUT' || (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  });
}

function overallStatus(rows: HealthCheckRow[]): HealthStatus {
  if (rows.some(row => row.status === 'error')) return 'error';
  if (rows.some(row => row.status === 'warn')) return 'warn';
  return 'ok';
}

export function aggregateHealthCheck(rows: HealthCheckRow[], cliPath?: string): HealthCheckResult {
  return { status: overallStatus(rows), rows, cliPath, checkedAt: new Date().toISOString() };
}

export type HealthCheckDependencies = {
  platform?: NodeJS.Platform | 'win32';
  home?: string;
  env?: NodeJS.ProcessEnv;
  configuredPath?: string | null;
  exists?: (candidate: string) => boolean;
  readSettings?: (env: NodeJS.ProcessEnv, home: string) => BaseUrlInfo;
  probePort?: (host: string, port: number) => Promise<boolean>;
  runVersion?: (cliPath: string, platform: NodeJS.Platform | 'win32', env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ ok: boolean; output?: string; timedOut?: boolean }>;
};

/** Runs local environment checks and returns only safe, user-facing facts. */
export async function checkEnvironment(dependencies: HealthCheckDependencies = {}): Promise<HealthCheckResult> {
  const platform = dependencies.platform ?? process.platform;
  const home = dependencies.home ?? os.homedir();
  const env = dependencies.env ?? process.env;
  const locate = findCliPath(platform, home, env, dependencies.exists ?? existsSync, dependencies.configuredPath);
  const rows: HealthCheckRow[] = [];

  if (!locate.cliPath) {
    rows.push({
      id: 'cli', status: 'error', labelCode: 'health.row.cli',
      detailCode: locate.configuredPath ? 'health.cli.configuredPathMissing' : 'health.cli.notFound',
      fixCode: 'health.cli.choose'
    });
    rows.push({ id: 'version', status: 'error', labelCode: 'health.row.version', detailCode: 'health.version.notRun', fixCode: 'health.version.chooseCli' });
  } else {
    const basename = (platform === 'win32' ? path.win32 : path).basename(locate.cliPath);
    let cliError: string | undefined;
    const extension = (platform === 'win32' ? path.win32 : path).extname(locate.cliPath).toLowerCase();
    if (!['.exe', '.cmd', '.bat', ''].includes(extension)) cliError = 'unsupported';
    else if ((extension === '.cmd' || extension === '.bat') && hasUtf8Bom(locate.cliPath)) cliError = 'bom';
    if (cliError) {
      rows.push({
        id: 'cli', status: 'error', labelCode: 'health.row.cli',
        detailCode: cliError === 'bom' ? 'cli.error.bom' : 'health.cli.unsupportedExtension',
        fixCode: 'health.cli.selectNoBom'
      });
      rows.push({ id: 'version', status: 'error', labelCode: 'health.row.version', detailCode: 'health.version.notRun', fixCode: 'health.version.fixPath' });
    } else {
      rows.push({ id: 'cli', status: 'ok', labelCode: 'health.row.cli', detailCode: 'health.cli.found', detailParams: { name: basename } });
      const version = await (dependencies.runVersion ?? runVersion)(locate.cliPath, platform, env, 8000);
      const parsed = version.ok ? parseCliVersion(version.output ?? '') : undefined;
      if (parsed) rows.push({ id: 'version', status: 'ok', labelCode: 'health.row.version', detailCode: 'health.version.parsed', detailParams: { version: parsed } });
      else if (version.timedOut) rows.push({ id: 'version', status: 'error', labelCode: 'health.row.version', detailCode: 'health.version.timeout', detailParams: { seconds: 8 }, fixCode: 'health.version.timeoutFix' });
      else if (!version.ok) rows.push({ id: 'version', status: 'error', labelCode: 'health.row.version', detailCode: 'health.version.cannotRun', fixCode: 'health.version.checkPath' });
      else rows.push({ id: 'version', status: 'warn', labelCode: 'health.row.version', detailCode: 'health.version.unrecognized', fixCode: 'health.version.runVersion' });
    }
  }

  let base: BaseUrlInfo;
  try { base = (dependencies.readSettings ?? readBaseUrl)(env, home); }
  catch {
    rows.push({ id: 'settings', status: 'warn', labelCode: 'health.row.settings', detailCode: 'health.settings.unreadable', fixCode: 'health.settings.checkReadable' });
    return aggregateHealthCheck(rows, locate.cliPath);
  }
  if (base.settingsInvalid) {
    rows.push({ id: 'settings', status: 'warn', labelCode: 'health.row.settings', detailCode: 'health.settings.invalidJson', fixCode: 'health.settings.fixJson' });
  } else {
    rows.push({ id: 'settings', status: 'ok', labelCode: 'health.row.settings', detailCode: base.baseUrl ? 'health.settings.apiRead' : 'health.settings.noCustomApi' });
  }

  if (base.local) {
    const listening = await (dependencies.probePort ?? isPortListening)(base.local.host, base.local.port);
    rows.push(listening
      ? { id: 'proxy', status: 'ok', labelCode: 'health.row.localProxy', detailCode: 'health.proxy.listening', detailParams: { port: base.local.port } }
      : { id: 'proxy', status: 'error', labelCode: 'health.row.localProxy', detailCode: 'health.proxy.notListening', detailParams: { port: base.local.port }, fixCode: 'health.proxy.start' });
  } else if (base.baseUrl) {
    try {
      new URL(base.baseUrl);
      rows.push({ id: 'proxy', status: 'ok', labelCode: 'health.row.api', detailCode: 'health.api.remote' });
    } catch {
      rows.push({ id: 'proxy', status: 'warn', labelCode: 'health.row.api', detailCode: 'health.api.unrecognized', fixCode: 'health.api.checkFormat' });
    }
  }

  return aggregateHealthCheck(rows, locate.cliPath);
}
