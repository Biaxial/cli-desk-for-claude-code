'use strict';
// Deterministic mock Claude Code CLI for stream-json protocol tests.
// Emits a stream-json sequence that echoes the user message with a "MOCK:" prefix.
const crypto = require('node:crypto');
function sessionFromArgs(argv) {
  const resumeAt = argv.indexOf('--resume');
  if (resumeAt >= 0 && argv[resumeAt + 1] && !argv[resumeAt + 1].startsWith('-')) return argv[resumeAt + 1];
  if (argv.includes('--continue')) return 'continued-session';
  return crypto.randomUUID();
}
const sessionId = sessionFromArgs(process.argv);
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'mock-model', tools: [] });
let turn = 0;
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.type === 'user' && message.message && Array.isArray(message.message.content)) {
      const text = String(message.message.content[0]?.text ?? '');
      turn += 1;
      const messageId = 'msg-' + turn;
      emit({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId, role: 'assistant', model: 'mock', content: [] } }, session_id: sessionId });
      emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sessionId });
      const full = 'MOCK:' + text;
      for (const ch of full) emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ch } }, session_id: sessionId });
      emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sessionId });
      emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, session_id: sessionId });
      emit({ type: 'stream_event', event: { type: 'message_stop' }, session_id: sessionId });
      emit({ type: 'result', subtype: 'success', result: full, session_id: sessionId, num_turns: 1, result_index: turn - 1, is_error: false, total_cost_usd: 0, usage: {} });
    }
  }
});
