'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { focusExistingWindow, shouldStartMainWindow } = require(path.join(__dirname, '../../dist/single-instance.cjs'));

function fakeWindow(overrides = {}) {
  const calls = [];
  const win = {
    destroyed: false,
    minimized: false,
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    restore() { calls.push('restore'); },
    show() { calls.push('show'); },
    focus() { calls.push('focus'); },
    ...overrides
  };
  return { win, calls };
}

test('the primary instance may open a window and a duplicate must not', () => {
  assert.equal(shouldStartMainWindow(true), true);
  assert.equal(shouldStartMainWindow(false), false);
});

test('focus restores a minimized window and activates it', () => {
  const { win, calls } = fakeWindow({ minimized: true });
  assert.equal(focusExistingWindow(win), true);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});

test('focus shows a visible window without restoring it', () => {
  const { win, calls } = fakeWindow();
  assert.equal(focusExistingWindow(win), true);
  assert.deepEqual(calls, ['show', 'focus']);
});

test('focus does nothing when the first window is missing or already closed', () => {
  assert.equal(focusExistingWindow(undefined), false);
  const { win, calls } = fakeWindow({ destroyed: true });
  assert.equal(focusExistingWindow(win), false);
  assert.deepEqual(calls, []);
});
