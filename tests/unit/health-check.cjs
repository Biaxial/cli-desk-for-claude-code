'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { buildCliCandidates, checkEnvironment, findCliPath, parseCliVersion, versionCommand } = require('../../dist/health-check.cjs');
const { isPortListening } = require('../../dist/claude-settings.cjs');
const { t } = require('../../dist/i18n.cjs');

function localizedRow(row, locale) {
  return {
    label: t(row.labelCode, {}, locale),
    detail: t(row.detailCode, row.detailParams, locale),
    fix: row.fixCode ? t(row.fixCode, row.fixParams, locale) : undefined
  };
}

test('Windows candidates use win32 paths and the supplied home directory', () => {
  const candidates = buildCliCandidates('win32', 'C:\\Users\\alice', {
    PATH: 'C:\\Tools',
    PATHEXT: '.EXE;.CMD;.BAT'
  });
  assert.deepEqual(candidates.slice(0, 4), [
    { path: 'C:\\Users\\alice\\.local\\bin\\claude.exe', source: 'default' },
    { path: 'C:\\Tools\\claude.exe', source: 'path' },
    { path: 'C:\\Tools\\claude.cmd', source: 'path' },
    { path: 'C:\\Tools\\claude.bat', source: 'path' }
  ]);
});

test('Windows .cmd version checks quote paths containing spaces for cmd.exe', () => {
  assert.deepEqual(versionCommand('C:\\Users\\a b\\AppData\\Roaming\\npm\\claude.cmd', 'win32', {}), {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', '""C:\\Users\\a b\\AppData\\Roaming\\npm\\claude.cmd" --version"'],
    windowsVerbatimArguments: true
  });
});

test('a configured CLI path has priority and does not silently fall back', () => {
  const exists = candidate => candidate === 'C:\\Custom\\claude.exe' || candidate === 'D:\\Tools\\claude.exe';
  assert.deepEqual(findCliPath('win32', 'C:\\Users\\alice', { PATH: 'D:\\Tools' }, exists, 'C:\\Custom\\claude.exe'), {
    cliPath: 'C:\\Custom\\claude.exe', source: 'settings'
  });
  assert.deepEqual(findCliPath('win32', 'C:\\Users\\alice', { PATH: 'D:\\Tools' }, exists, 'C:\\Missing\\claude.exe'), {
    source: 'missing', configuredPath: 'C:\\Missing\\claude.exe'
  });
});

test('PATH search honors Windows PATHEXT with an injectable exists check', () => {
  const found = findCliPath('win32', 'C:\\Users\\alice', {
    PATH: 'C:\\One;D:\\Two',
    PATHEXT: '.EXE;.CMD;.BAT'
  }, candidate => candidate === 'D:\\Two\\claude.cmd');
  assert.deepEqual(found, { cliPath: 'D:\\Two\\claude.cmd', source: 'path' });
});

test('parses Claude Code version output without returning arbitrary text', () => {
  assert.equal(parseCliVersion('2.1.3 (Claude Code)\n'), '2.1.3 (Claude Code)');
  assert.equal(parseCliVersion('Claude Code v2.1.3'), 'Claude Code v2.1.3');
  assert.equal(parseCliVersion('API_TOKEN=private-value'), undefined);
});

function baseInfo(baseUrl, local) {
  return {
    baseUrl,
    source: baseUrl ? 'settings' : 'none',
    settingsPath: 'not-returned-to-ui',
    settingsFound: !!baseUrl,
    settingsInvalid: false,
    local
  };
}

test('a local URL without a listening port reports the proxy fix', async () => {
  const result = await checkEnvironment({
    platform: 'win32', home: 'C:\\Users\\alice', env: {}, configuredPath: 'C:\\Claude\\claude.exe',
    exists: () => true,
    runVersion: async () => ({ ok: true, output: '2.1.3 (Claude Code)' }),
    readSettings: () => baseInfo('http://localhost:15721', { host: '127.0.0.1', port: 15721 }),
    probePort: async () => false
  });
  const proxy = result.rows.find(row => row.id === 'proxy');
  assert.equal(result.status, 'error');
  assert.equal(proxy.status, 'error');
  assert.match(localizedRow(proxy, 'zh-CN').fix, /启动 CC Switch/);
  assert.match(localizedRow(proxy, 'en').fix, /Start CC Switch/);
  assert.match(localizedRow(proxy, 'en').detail, /local port 15721/);
});

test('remote base URLs are informational and do not trigger a port probe', async () => {
  let probed = false;
  const result = await checkEnvironment({
    platform: 'win32', home: 'C:\\Users\\alice', env: {}, configuredPath: 'C:\\Claude\\claude.exe',
    exists: () => true,
    runVersion: async () => ({ ok: true, output: '2.1.3 (Claude Code)' }),
    readSettings: () => baseInfo('https://api.example.test/v1', undefined),
    probePort: async () => { probed = true; return false; }
  });
  assert.equal(probed, false);
  assert.equal(result.status, 'ok');
  const proxy = result.rows.find(row => row.id === 'proxy');
  assert.match(localizedRow(proxy, 'zh-CN').detail, /跳过本地端口检查/);
  assert.match(localizedRow(proxy, 'en').detail, /remote address is configured/);
});

test('settings tokens never appear in the health check result', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cc-desktop-health-settings-'));
  const token = 'private-health-token-should-never-escape';
  try {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://user:password@api.example.test/v1?key=url-secret', ANTHROPIC_AUTH_TOKEN: token }
    }));
    const result = await checkEnvironment({
      platform: 'win32', home, env: {}, configuredPath: 'C:\\Claude\\claude.exe',
      exists: () => true,
      runVersion: async () => ({ ok: true, output: '2.1.3 (Claude Code)' })
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes('url-secret'), false);
    assert.equal(serialized.includes('password'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('invalid Claude settings JSON is reported as a warning', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cc-desktop-health-invalid-settings-'));
  try {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), '{ invalid');
    const result = await checkEnvironment({
      platform: 'win32', home, env: {}, configuredPath: 'C:\\Claude\\claude.exe',
      exists: () => true,
      runVersion: async () => ({ ok: true, output: '2.1.3 (Claude Code)' })
    });
    const settings = result.rows.find(row => row.id === 'settings');
    assert.equal(settings.status, 'warn');
    assert.match(localizedRow(settings, 'zh-CN').fix, /修复.*JSON/);
    assert.match(localizedRow(settings, 'en').fix, /Fix the JSON format/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('missing CLI reports a concrete settings fix', async () => {
  const result = await checkEnvironment({
    platform: 'win32', home: 'C:\\Users\\alice', env: { PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD;.BAT' },
    exists: () => false,
    readSettings: () => baseInfo(undefined, undefined)
  });
  const cli = result.rows.find(row => row.id === 'cli');
  assert.equal(result.status, 'error');
  assert.equal(cli.status, 'error');
  assert.match(localizedRow(cli, 'zh-CN').fix, /在设置中选择 claude\.exe/);
  assert.match(localizedRow(cli, 'en').fix, /Choose claude\.exe in Settings/);
});

test('health-check rows retain codes and localize labels and dynamic values at render time', async () => {
  const result = await checkEnvironment({
    platform: 'win32', home: 'C:\\Users\\alice', env: {}, configuredPath: 'C:\\Claude\\claude.exe',
    exists: () => true,
    runVersion: async () => ({ ok: true, output: '2.1.3 (Claude Code)' }),
    readSettings: () => baseInfo('http://localhost:15721', { host: '127.0.0.1', port: 15721 }),
    probePort: async () => false
  });
  const cli = result.rows.find(row => row.id === 'cli');
  const proxy = result.rows.find(row => row.id === 'proxy');
  assert.equal(localizedRow(cli, 'zh-CN').label, 'Claude CLI');
  assert.equal(localizedRow(cli, 'en').detail, 'Found: claude.exe');
  assert.equal(localizedRow(proxy, 'zh-CN').detail, '本机端口 15721 没有程序在监听；CC Switch 等本地代理可能未启动。');
  assert.equal(localizedRow(proxy, 'en').detail, 'Nothing is listening on local port 15721; a local proxy such as CC Switch may not be running.');
  assert.doesNotMatch(JSON.stringify(localizedRow(proxy, 'en')), /[\u3400-\u9fff]/u);
});

test('the real port probe detects a listening TCP server', async t => {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('sandbox does not permit localhost listeners');
      return;
    }
    throw error;
  }
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(await isPortListening('127.0.0.1', address.port), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
