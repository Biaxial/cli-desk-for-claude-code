'use strict';
// Echoes the user text and exits, so the next send must relaunch with --resume.
// Used to prove a second Chinese turn survives settle/relaunch.
const crypto = require('node:crypto');
const { createFrameState, pushProtocolBytes, decodeProtocolLine } = require('../../dist/byte-lines.cjs');

function sessionFromArgs(argv) {
  const resumeAt = argv.indexOf('--resume');
  if (resumeAt >= 0 && argv[resumeAt + 1] && !argv[resumeAt + 1].startsWith('-')) return argv[resumeAt + 1];
  return crypto.randomUUID();
}

const sessionId = sessionFromArgs(process.argv);
const emit = obj => process.stdout.write(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'));
const frame = createFrameState();
process.stdin.on('data', chunk => {
  const lines = pushProtocolBytes(frame, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  for (const line of lines) {
    const text = decodeProtocolLine(line);
    if (!text.trim()) continue;
    let message;
    try { message = JSON.parse(text); } catch { continue; }
    if (message.type !== 'user') continue;
    const parts = message.message && message.message.content;
    const userText = Array.isArray(parts) ? String(parts[0]?.text ?? '') : '';
    emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'example-model-pro', tools: [] });
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', model: 'example-model-pro', content: [{ type: 'text', text: userText }] }
    });
    emit({ type: 'result', subtype: 'success', is_error: false, result: userText, session_id: sessionId, total_cost_usd: 0 });
    setTimeout(() => process.exit(0), 30);
  }
});
