const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { validateCliPath } = require('../../dist/validate-cli.cjs');
const windowsOnly = process.platform === 'win32' ? {} : { skip: 'CLI .cmd/.exe version probe runs on Windows only' };

test('Windows CLI version probe accepts a .cmd launcher under a spaced path', windowsOnly, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc desktop spaced '));
  const launcher = path.join(directory, 'synthetic cli.cmd');
  writeFileSync(launcher, '@echo off\r\necho cc-desktop-test 1.0\r\n');
  assert.equal(validateCliPath(launcher), launcher);
});
