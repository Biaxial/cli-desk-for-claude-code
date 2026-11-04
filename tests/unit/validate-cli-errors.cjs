const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { validateCliPath, CliValidationError } = require('../../dist/validate-cli.cjs');
const { t } = require('../../dist/i18n.cjs');
const windowsOnly = process.platform === 'win32' ? {} : { skip: 'CLI .cmd/.exe version probe runs on Windows only' };

function makeCli(name, content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-cli-'));
  const cli = path.join(dir, name);
  writeFileSync(cli, content);
  return cli;
}

test('accepts a CLI that prints a version and exits 0', windowsOnly, () => {
  const cli = makeCli('ok.cmd', '@echo off\r\necho 1.2.3\r\nexit /b 0\r\n');
  assert.equal(validateCliPath(cli), cli);
});

test('classifies a non-zero exit code', windowsOnly, () => {
  const cli = makeCli('fail.cmd', '@echo off\r\nexit /b 3\r\n');
  assert.throws(() => validateCliPath(cli), (e) =>
    e instanceof CliValidationError && e.kind === 'non-zero-exit' && /非零/.test(e.message) && e.diagnostic.exitCode === 3);
});

test('classifies a start error for an unexecutable .exe', windowsOnly, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-cli-'));
  const cli = path.join(dir, 'fake.exe');
  writeFileSync(cli, 'this is not a valid executable');
  assert.throws(() => validateCliPath(cli), (e) => e instanceof CliValidationError && e.kind === 'start-error');
});

test('classifies a timeout for a hanging CLI', windowsOnly, () => {
  const cli = makeCli('hang.cmd', '@echo off\r\n:loop\r\ngoto loop\r\n');
  assert.throws(() => validateCliPath(cli, 1500), (e) =>
    e instanceof CliValidationError && e.kind === 'timeout' && /超时/.test(e.message));
});

test('accepts empty stdout when the exit code is 0', windowsOnly, () => {
  const cli = makeCli('empty.cmd', '@echo off\r\nexit /b 0\r\n');
  assert.equal(validateCliPath(cli), cli);
});

test('accepts stderr content when the exit code is 0', windowsOnly, () => {
  const cli = makeCli('stderr.cmd', '@echo off\r\necho warning 1>&2\r\nexit /b 0\r\n');
  assert.equal(validateCliPath(cli), cli);
});

test('strips a path BOM and rejects a .cmd file that starts with UTF-8 BOM', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-bom-'));
  const cli = path.join(dir, 'launcher.cmd');
  writeFileSync(cli, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('@echo off\r\necho 1\r\n')]));
  assert.throws(() => validateCliPath('\uFEFF' + cli), (e) =>
    e instanceof CliValidationError && e.kind === 'start-error' && /BOM/.test(e.message) && !/\bnull\b/.test(e.message));
});

test('classifies a missing file as not-found', windowsOnly, () => {
  assert.throws(() => validateCliPath('C:/definitely/missing/claude.exe'), (e) =>
    e instanceof CliValidationError && e.kind === 'not-found' && /不存在/.test(e.message));
});

test('CLI validation errors carry stable translation codes and parameters', () => {
  assert.throws(() => validateCliPath('relative/claude.exe'), error => {
    assert.ok(error instanceof CliValidationError);
    assert.equal(error.code, 'cli.error.notAbsolute');
    assert.equal(error.message, t(error.code, error.params, 'zh-CN'));
    assert.equal(t(error.code, error.params, 'en'), 'Choose an absolute path to an .exe or .cmd file');
    return true;
  });
});
