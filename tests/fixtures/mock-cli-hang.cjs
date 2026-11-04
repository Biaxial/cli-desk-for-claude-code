'use strict';
// Mock CLI that emits init and then hangs forever (never emits a result).
const crypto = require('node:crypto');
const sessionId = crypto.randomUUID();
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'mock', tools: [] }) + '\n');
process.stdin.resume();
