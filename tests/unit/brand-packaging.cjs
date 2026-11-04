'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const packaged = path.join(root, 'dist/renderer/brand/biaxial-studio-mark-128.png');
const source = path.join(root, 'resources/brand/biaxial-studio-mark-128.png');

test('renderer packages the small Biaxial Studio mark', () => {
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(packaged), true);
  const shipped = fs.readFileSync(packaged);
  const original = fs.readFileSync(source);
  assert.ok(shipped.length > 32 && shipped.length < 100000, 'mark should be a small png, not a master image');
  assert.deepEqual(shipped, original);
  assert.equal(shipped.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(fs.existsSync(path.join(root, 'dist/renderer/brand/biaxial-studio-mark-64.png')), true);
  assert.equal(fs.existsSync(path.join(root, 'dist/resources/brand/biaxial-studio-mark-128.png')), true);

  const html = fs.readFileSync(path.join(root, 'dist/renderer/index.html'), 'utf8');
  assert.match(html, /src="brand\/biaxial-studio-mark-128\.png"/);
  assert.match(html, /独立第三方项目/);
  assert.match(html, /非官方产品/);
  assert.doesNotMatch(html, /biaxial-studio-logo\.png/);
  assert.doesNotMatch(html, /biaxial-studio-mark-256/);
  assert.doesNotMatch(html, /Claude Desktop/);
  const disclaimer = html.match(/<p id="aboutDisclaimer"[^>]*>[\s\S]*?<\/p>/);
  assert.ok(disclaimer, 'the full disclaimer must be present in the About template');
  assert.match(disclaimer[0], /Anthropic/);
  assert.doesNotMatch(html.replace(disclaimer[0], ''), /Anthropic/i, 'Anthropic should only appear inside the full disclaimer');

  const app = fs.readFileSync(path.join(root, 'dist/renderer/app.js'), 'utf8');
  for (const needle of ['正在思考', '继续最近', '新会话', '思考', 'Cerebrating']) {
    assert.equal(app.includes(needle), true, `renderer bundle missing ${needle}`);
  }
  assert.equal(app.includes('biaxial-studio-logo.png'), false);
  assert.equal(app.includes('brand/status/assistant-idle.png'), true);
  assert.equal(app.includes('brand/status/working-cerebrating.gif'), true);
  assert.equal(app.toLowerCase().includes('clauding'), false);

  const statusDir = path.join(root, 'dist/renderer/brand/status');
  const idle = fs.readFileSync(path.join(statusDir, 'assistant-idle.png'));
  const working = fs.readFileSync(path.join(statusDir, 'working-cerebrating.gif'));
  assert.deepEqual(idle, fs.readFileSync(path.join(root, 'resources/brand/status/assistant-idle.png')));
  assert.deepEqual(working, fs.readFileSync(path.join(root, 'resources/brand/status/working-cerebrating.gif')));
  assert.equal(idle.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(working.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(fs.existsSync(path.join(root, 'dist/renderer/brand/status/working-frame-ref.png')), false);
  assert.match(html, /brand\/status\/assistant-idle\.png/);
  assert.match(html, /id="homeMark"/);
  assert.match(html, /class="home-mark"/);
  assert.equal(app.includes('/model'), true);
  assert.equal(app.includes('选择模型'), true);
  assert.equal(app.includes('新聊天'), true);
  assert.equal(app.includes('推荐模型集'), true);
  assert.equal(app.includes('模型名称，例如'), false);
  assert.equal(app.includes('询问当前模型'), false);
  assert.equal(app.includes('会话 ${'), false);
  assert.equal(app.includes('homeMark'), true);
  assert.equal(fs.existsSync(path.join(root, 'resources/icons/claude-mark.png')), true);
  assert.equal(fs.existsSync(path.join(root, 'resources/icons/claude-mark.ico')), true);
});
