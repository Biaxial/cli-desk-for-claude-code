'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { formatDroppedPaths, insertPathSnippet, pathFromFileUri, shouldBlockNavigation } = require(path.join(root, 'dist/dropped-paths.cjs'));

test('a different URL is blocked so a file drop cannot replace the app', () => {
  const appUrl = 'file:///C:/CC-Desktop/dist/renderer/index.html';
  assert.equal(shouldBlockNavigation(appUrl, 'file:///C:/Users/alice/notes.txt'), true);
  assert.equal(shouldBlockNavigation(appUrl, appUrl), false);
  assert.equal(shouldBlockNavigation('', 'file:///C:/Users/alice/notes.txt'), false);
});

test('file URIs become local paths and quoted when they contain spaces', () => {
  assert.equal(pathFromFileUri('file:///C:/Users/alice/My%20Notes.txt'), 'C:\\Users\\alice\\My Notes.txt');
  assert.equal(pathFromFileUri('file:///home/alice/a.txt'), '/home/alice/a.txt');
  assert.equal(pathFromFileUri('file:///C:/bad%XX.txt'), '');
  assert.equal(pathFromFileUri('https://example.com/a'), '');
  const formatted = formatDroppedPaths(['C:\\work\\a.ts', 'C:\\work\\my file.ts']);
  assert.equal(formatted.text, 'C:\\work\\a.ts "C:\\work\\my file.ts"');
  assert.equal(formatted.omitted, 0);
});

test('dropped paths are inserted at the caret without gluing to nearby words', () => {
  const next = insertPathSnippet('请看这个', 4, 4, 'C:\\work\\a.ts');
  assert.equal(next.value, '请看这个 C:\\work\\a.ts');
  assert.equal(next.caret, next.value.length);
});

test('the built app denies extra windows and keeps file drops in the composer', () => {
  const main = fs.readFileSync(path.join(root, 'dist/main.cjs'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'dist/renderer/app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'dist/preload.cjs'), 'utf8');
  assert.equal(main.includes('setWindowOpenHandler'), true);
  assert.equal(main.includes('shouldBlockNavigation'), true);
  assert.equal(app.includes('dragover'), true);
  assert.equal(preload.includes('getPathForFile'), true);
  assert.equal(app.includes('M12.22 2h-.44a2 2 0 0 0-2 2'), true);
  assert.equal(app.includes('M4 12h2M18 12h2M12 4v2'), false);
});
