'use strict';
// Emits the CLI's synthetic assistant response for a local connection failure.
const crypto = require('node:crypto');
const sessionId = crypto.randomUUID();
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'claude-sonnet-4-5', tools: [] });

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    if (command.type !== 'user') continue;
    const text = 'API Error: Connection error. ECONNREFUSED 127.0.0.1:15721';
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: { id: 'synthetic-error', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }
    });
    emit({ type: 'result', subtype: 'api_error', result: text, is_error: true, session_id: sessionId });
  }
});
