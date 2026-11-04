'use strict';
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const exe = path.join(root, 'dist/native/NativeSupervisor.exe');
const bridge = path.join(root, 'tests/fixtures/direct-supervisor.cjs');

function useNativeSupervisor() {
  return process.platform === 'win32' && existsSync(exe);
}

function openSupervisor(lockScope, lockKey, helperPath) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const stdio = ['pipe', 'pipe', 'pipe'];
  if (useNativeSupervisor()) {
    return spawn(exe, [lockScope, lockKey, process.execPath, helperPath], { cwd: root, stdio, windowsHide: true, env });
  }
  return spawn(process.execPath, [bridge, lockScope, lockKey, process.execPath, helperPath], { cwd: root, stdio, windowsHide: true, env });
}

module.exports = { openSupervisor, useNativeSupervisor };
