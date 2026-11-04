import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { CatalogModel, MODEL_PROBE_ARGS, parseModelCatalog } from '../../shared/model-catalog';
import { t, type Locale } from '../../shared/i18n';

export type ModelProbeResult = {
  models: CatalogModel[];
  error?: string;
  fromCache: boolean;
};

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key === 'ELECTRON_RUN_AS_NODE' || /^CLAUDE_CODE_|^CLAUDE_EFFORT$|^CLAUDE_PID$/.test(key)) delete env[key];
  }
  return env;
}

function launch(cliPath: string, cwd: string): ChildProcess {
  const options = { cwd, env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  if (cliPath.toLowerCase().endsWith('.cmd')) {
    const comSpec = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const command = [quoteCmd(cliPath), ...MODEL_PROBE_ARGS.map(quoteCmd)].join(' ');
    return spawn(comSpec, ['/d', '/s', '/c', command], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(cliPath, MODEL_PROBE_ARGS, options);
}

/** One-shot `claude -p /model`. Empty output is not an error by itself; the caller can use cache. */
export function probeModels(cliPath: string, cwd: string, timeoutMs = 15000, locale: Locale = 'zh-CN'): Promise<ModelProbeResult> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try { child = launch(cliPath, cwd); }
    catch (error) {
      resolve({ models: [], fromCache: false, error: error instanceof Error ? t('model.probe.start', { reason: error.message }, locale) : t('model.probe.startFailed', {}, locale) });
      return;
    }
    let output = '';
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const models = parseModelCatalog(output);
      resolve({ models, fromCache: false, error: models.length > 0 ? undefined : error });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish(t('model.probe.timeout', {}, locale));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output = (output + chunk).slice(-200000); });
    child.stderr?.on('data', (chunk: string) => { output = (output + '\n' + chunk).slice(-200000); });
    child.on('error', error => finish(error.message));
    child.on('exit', code => finish(code && code !== 0 ? t('model.probe.exit', { code }, locale) : undefined));
  });
}
