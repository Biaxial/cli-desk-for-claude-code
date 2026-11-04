'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { readBaseUrl, isPortListening } = require(path.join(root, 'dist/claude-settings.cjs'));

function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cc-desktop-settings-'));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

test('reads and redacts only ANTHROPIC_BASE_URL from settings.json', () => {
  const home = makeHome();
  try {
    const secret = 'never-return-this-auth-token';
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://alice:password@example.test/v1?key=url-secret',
        ANTHROPIC_AUTH_TOKEN: secret
      }
    }));
    const info = readBaseUrl({}, home);
    assert.equal(info.baseUrl, 'https://example.test/v1');
    assert.equal(info.source, 'settings');
    assert.equal(info.settingsFound, true);
    assert.equal(info.local, undefined);
    assert.equal(JSON.stringify(info).includes(secret), false);
    assert.equal(JSON.stringify(info).includes('url-secret'), false);
    assert.equal(JSON.stringify(info).includes('password'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('accepts a UTF-8 BOM in settings.json', () => {
  const home = makeHome();
  try {
    writeFileSync(path.join(home, '.claude', 'settings.json'), '\uFEFF{"env":{"ANTHROPIC_BASE_URL":"http://localhost:15721"}}');
    const info = readBaseUrl({}, home);
    assert.equal(info.settingsInvalid, false);
    assert.equal(info.baseUrl, 'http://localhost:15721');
    assert.deepEqual(info.local, { host: '127.0.0.1', port: 15721 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reports invalid JSON and falls back to the inherited base URL', () => {
  const home = makeHome();
  try {
    writeFileSync(path.join(home, '.claude', 'settings.json'), '{ invalid');
    const info = readBaseUrl({ ANTHROPIC_BASE_URL: 'https://env.example.test/v1' }, home);
    assert.equal(info.settingsFound, true);
    assert.equal(info.settingsInvalid, true);
    assert.equal(info.source, 'environment');
    assert.equal(info.baseUrl, 'https://env.example.test/v1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('uses environment fallback when settings.json is missing', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cc-desktop-settings-missing-'));
  try {
    const info = readBaseUrl({ ANTHROPIC_BASE_URL: 'https://env.example.test' }, home);
    assert.equal(info.settingsFound, false);
    assert.equal(info.settingsInvalid, false);
    assert.equal(info.source, 'environment');
    assert.equal(info.baseUrl, 'https://env.example.test');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reports no configured base URL when settings and environment are empty', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cc-desktop-settings-empty-'));
  try {
    const info = readBaseUrl({}, home);
    assert.equal(info.source, 'none');
    assert.equal(info.baseUrl, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('isPortListening detects an accepting local server and a closed port', async t => {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('当前沙箱不允许监听本机 TCP 端口');
      return;
    }
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(await isPortListening('127.0.0.1', address.port), true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await isPortListening('127.0.0.1', address.port), false);
});
