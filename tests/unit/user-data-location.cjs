'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveUserDataLocation } = require('../../dist/user-data-location.cjs');

const appDataDir = path.resolve('/profile/AppData');
const sourceRoot = path.resolve('/workspace/source');
const newDefault = path.join(appDataDir, 'CLI Desk for Claude Code');
const ccDesktopLegacy = path.join(appDataDir, 'CC Desktop');
const ccDesktopPackageLegacy = path.join(appDataDir, 'cc-desktop');

function resolve(env = {}, existing = new Set(), writes = []) {
  const existsCalls = [];
  const injectedFs = {
    existsSync(candidate) {
      existsCalls.push(candidate);
      return existing.has(path.normalize(candidate));
    },
    mkdirSync(...args) { writes.push(['mkdirSync', ...args]); },
    writeFileSync(...args) { writes.push(['writeFileSync', ...args]); },
    renameSync(...args) { writes.push(['renameSync', ...args]); },
    rmSync(...args) { writes.push(['rmSync', ...args]); },
  };
  const location = resolveUserDataLocation({
    env,
    appDataDir,
    sourceRoot,
    ...injectedFs,
  });
  return { location, existsCalls, writes };
}

test('CLI_DESK_USER_DATA selects an absolute external directory', () => {
  const target = path.resolve('/profile/CLI Desk Data');
  const { location } = resolve({ CLI_DESK_USER_DATA: target });
  assert.deepEqual(location, { path: target, source: 'env' });
});

test('CC_DESKTOP_USER_DATA remains a supported legacy environment alias', () => {
  const target = path.resolve('/profile/CLI-Desk-Test');
  const { location } = resolve({ CC_DESKTOP_USER_DATA: target });
  assert.deepEqual(location, { path: target, source: 'env-legacy' });
});

test('the new environment variable wins when both aliases are set', () => {
  const target = path.resolve('/profile/new-data');
  const { location } = resolve({ CLI_DESK_USER_DATA: target, CC_DESKTOP_USER_DATA: path.resolve('/profile/old-data') });
  assert.deepEqual(location, { path: target, source: 'env' });
});

test('relative and source-tree environment paths are rejected with the existing error', () => {
  const expected = 'Acceptance userData must be an absolute directory outside the source tree';
  assert.throws(() => resolve({ CLI_DESK_USER_DATA: 'relative-data' }), { message: expected });
  assert.throws(() => resolve({ CC_DESKTOP_USER_DATA: path.join(sourceRoot, 'inside') }), { message: expected });
});

test('an existing new default takes precedence over legacy stores', () => {
  const existing = new Set([path.normalize(newDefault), path.normalize(path.join(ccDesktopLegacy, 'settings.json'))]);
  const { location } = resolve({}, existing);
  assert.deepEqual(location, { path: newDefault, source: 'default' });
});

test('a legacy CC Desktop store with settings is selected in place', () => {
  const { location } = resolve({}, new Set([path.normalize(path.join(ccDesktopLegacy, 'settings.json'))]));
  assert.deepEqual(location, { path: ccDesktopLegacy, source: 'legacy-default' });
});

test('a legacy cc-desktop store with sessions is selected in place', () => {
  const { location } = resolve({}, new Set([path.normalize(path.join(ccDesktopPackageLegacy, 'sessions'))]));
  assert.deepEqual(location, { path: ccDesktopPackageLegacy, source: 'legacy-default' });
});

test('an empty legacy directory is ignored', () => {
  const emptyLegacyDirectory = new Set([path.normalize(ccDesktopLegacy)]);
  const { location } = resolve({}, emptyLegacyDirectory);
  assert.deepEqual(location, { path: newDefault, source: 'default' });
});

test('no existing stores selects the new default', () => {
  const { location } = resolve();
  assert.deepEqual(location, { path: newDefault, source: 'default' });
});

test('resolution only probes existence and never creates or writes data', () => {
  const writes = [];
  const { location, existsCalls } = resolve({}, new Set([path.normalize(path.join(ccDesktopLegacy, 'sessions.json'))]), writes);
  assert.deepEqual(location, { path: ccDesktopLegacy, source: 'legacy-default' });
  assert.ok(existsCalls.length > 0, 'existence checks should be injected');
  assert.deepEqual(writes, []);
});
