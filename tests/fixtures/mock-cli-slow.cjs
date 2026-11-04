'use strict';
// Streams a visible prefix and then remains in-flight until stopped.
const crypto = require('node:crypto');
const fs = require('node:fs');
const resumeAt = process.argv.indexOf('--resume');
const sessionId = resumeAt >= 0 ? process.argv[resumeAt + 1] : crypto.randomUUID();
const emit = value => fs.writeSync(1, JSON.stringify(value) + '\n');

emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'mock-model' });
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
    emit({ type: 'stream_event', event: { type: 'message_start' }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PARTIAL-STOP' } }, session_id: sessionId });
    // Deliberately never completes this turn. The test stops the CLI mid-stream.
  }
});
