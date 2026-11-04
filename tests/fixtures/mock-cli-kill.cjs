'use strict';
// Emits a canonical assistant message and then dies with no numeric exit code.
const crypto = require('node:crypto');
const fs = require('node:fs');
const sessionId = crypto.randomUUID();
const emit = obj => fs.writeSync(1, JSON.stringify(obj) + '\n');
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type !== 'user') continue;
    emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'mock-model' });
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'do not persist this' },
          { type: 'text', text: 'PARTIAL' }
        ]
      }
    });
    setTimeout(() => {
      try { process.kill(process.pid, 'SIGKILL'); }
      catch { process.exit(1); }
    }, 80);
  }
});