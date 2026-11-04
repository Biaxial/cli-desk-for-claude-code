'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseModelCatalog, MODEL_PROBE_ARGS } = require(path.join(__dirname, '../../dist/model-catalog.cjs'));

test('probe asks the CLI slash command /model', () => {
  assert.equal(MODEL_PROBE_ARGS.at(-1), '/model');
  assert.equal(MODEL_PROBE_ARGS.includes('--output-format'), true);
});

test('section headers become 默认 and 推荐模型集 rows', () => {
  const models = parseModelCatalog(`
默认
claude-opus-4-6 (default)
推荐模型集
claude-sonnet-4-6
example-model-pro
Example 2 Mini
`);
  assert.deepEqual(models.map(model => [model.section, model.id]), [
    ['default', 'claude-opus-4-6'],
    ['recommended', 'claude-sonnet-4-6'],
    ['recommended', 'example-model-pro'],
    ['recommended', 'Example 2 Mini']
  ]);
});

test('a stream-json result line is read and the current model is 默认', () => {
  const line = JSON.stringify({
    type: 'result',
    result: 'Available models:\n- claude-haiku-4-5 (current)\n- claude-sonnet-4-6\n'
  });
  const models = parseModelCatalog(line + '\nnoise that is not a model row because it is a full sentence about picking one.');
  assert.equal(models[0].section, 'default');
  assert.equal(models[0].id, 'claude-haiku-4-5');
  assert.equal(models[0].label, 'claude-haiku-4-5');
  assert.equal(models.some(model => model.id === 'claude-sonnet-4-6'), true);
});
