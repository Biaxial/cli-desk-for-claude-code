'use strict';
// Real-shaped Claude stream-json: init arrives only after the user message,
// the visible reply is a canonical `assistant` message (not only stream deltas),
// then the process exits. Thinking must not become the saved transcript.
const crypto = require('node:crypto');

function sessionFromArgs(argv) {
  const resumeAt = argv.indexOf('--resume');
  if (resumeAt >= 0 && argv[resumeAt + 1] && !argv[resumeAt + 1].startsWith('-')) return argv[resumeAt + 1];
  return crypto.randomUUID();
}

const sessionId = sessionFromArgs(process.argv);
const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n');
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
    emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'mock-model', tools: [] });
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: {
        role: 'assistant',
        model: 'mock-model',
        content: [
          { type: 'thinking', thinking: 'hidden chain of thought' },
          { type: 'text', text: 'VISIBLE-ASSISTANT' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file: 'a.ts' } }
        ]
      }
    });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'VISIBLE-ASSISTANT', session_id: sessionId, total_cost_usd: 0 });
    setTimeout(() => process.exit(0), 40);
  }
});