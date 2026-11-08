'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const electron = require('electron');

const root = path.resolve(__dirname, '../..');
const main = path.join(root, 'dist/main.cjs');

function launch(userData) {
  const env = { ...process.env, CLI_DESK_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, ['--no-sandbox', '--disable-gpu', main], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', () => {});
  return { child, stderr: () => stderr };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await waitForExit(child, 5000);
}

test('a second launch with the same userData exits and the first process keeps the window', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'cli-desk-single-'));
  const first = launch(userData);
  try {
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(first.child.exitCode, null, `first instance exited early: ${first.stderr()}`);
    const second = launch(userData);
    const secondExit = await waitForExit(second.child, 8000);
    assert.ok(secondExit, `second instance stayed alive: ${second.stderr()}`);
    assert.equal(secondExit.code, 0, `second instance stderr: ${second.stderr()}`);
    assert.equal(first.child.exitCode, null, `first instance was replaced: ${first.stderr()}`);
  } finally {
    await stop(first.child);
    rmSync(userData, { recursive: true, force: true });
  }
});

test('two userData directories can each hold one CLI Desk process', async () => {
  const firstData = mkdtempSync(path.join(tmpdir(), 'cli-desk-a-'));
  const secondData = mkdtempSync(path.join(tmpdir(), 'cli-desk-b-'));
  const first = launch(firstData);
  const second = launch(secondData);
  try {
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(first.child.exitCode, null, first.stderr());
    assert.equal(second.child.exitCode, null, second.stderr());
  } finally {
    await stop(first.child);
    await stop(second.child);
    rmSync(firstData, { recursive: true, force: true });
    rmSync(secondData, { recursive: true, force: true });
  }
});
