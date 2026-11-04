'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const { createFrameState, pushProtocolBytes, decodeProtocolLine, isStopLine } = require(path.join(root, 'dist/byte-lines.cjs'));
const { modelSlashCommand } = require(path.join(root, 'dist/resume-plan.cjs'));

const userLine = Buffer.from('{"type":"user","message":"你是谁"}\n', 'utf8');

test('UTF-8 user frames survive one-byte pipe reads', () => {
  const state = createFrameState();
  const lines = [];
  for (const byte of userLine) lines.push(...pushProtocolBytes(state, Buffer.from([byte])));
  assert.equal(lines.length, 1);
  assert.equal(decodeProtocolLine(lines[0]), '{"type":"user","message":"你是谁"}');
  assert.equal(JSON.parse(decodeProtocolLine(lines[0])).message, '你是谁');
  assert.equal(state.pending.length, 0);
});

test('CRLF and a leading BOM still decode as one JSON object', () => {
  const state = createFrameState();
  const framed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"type":"user","message":"你好"}\r\n', 'utf8')]);
  const lines = pushProtocolBytes(state, framed);
  assert.equal(JSON.parse(decodeProtocolLine(lines[0])).message, '你好');
});

test('stop is detected without swallowing a following UTF-8 frame', () => {
  const state = createFrameState();
  const blob = Buffer.concat([Buffer.from('stop\r\n', 'ascii'), userLine]);
  const lines = pushProtocolBytes(state, blob);
  assert.equal(isStopLine(lines[0]), true);
  assert.equal(JSON.parse(decodeProtocolLine(lines[1])).message, '你是谁');
});

test('UTF-16BE embedded in an otherwise ASCII user line is the position-31 failure', () => {
  const prefix = Buffer.from('{"type":"user","message":"', 'ascii');
  const be = Buffer.from('你是谁', 'utf16le').swap16();
  const suffix = Buffer.from('"}\n', 'ascii');
  const text = decodeProtocolLine(Buffer.concat([prefix, be, suffix]).subarray(0, prefix.length + be.length + 2));
  assert.throws(() => JSON.parse(text), /Bad control character in string literal in JSON at position 31/);
});

test('model picker text is a Claude CLI /model slash command', () => {
  assert.equal(modelSlashCommand(), '/model');
  assert.equal(modelSlashCommand('  '), '/model');
  assert.equal(modelSlashCommand('example-model-pro'), '/model example-model-pro');
  assert.equal(modelSlashCommand('/model claude-sonnet'), '/model claude-sonnet');
  assert.throws(() => modelSlashCommand('bad\nname'), /模型名称无效/);
});
