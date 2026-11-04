'use strict';
// One turn that mixes thinking, visible text, and a tool call.
// Thinking must not become the persisted user-facing transcript.
const crypto = require('node:crypto');
const sessionId = crypto.randomUUID();
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'mock-model', tools: [] });
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
    if (message.type !== 'user') continue;
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-rich', role: 'assistant', model: 'mock', content: [] } }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'internal analysis should stay out of the transcript' } }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'VISIBLE' } }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file":"a.ts"}' } }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 2 }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, session_id: sessionId });
    emit({ type: 'stream_event', event: { type: 'message_stop' }, session_id: sessionId });
    emit({ type: 'result', subtype: 'success', result: 'VISIBLE', session_id: sessionId, is_error: false, total_cost_usd: 0, usage: {} });
  }
});
