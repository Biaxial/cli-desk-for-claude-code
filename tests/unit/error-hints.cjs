'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const {
  classifyCliError,
  errorHintText,
  isSyntheticModel,
  usableModel,
  redactUrl,
  localEndpoint
} = require(path.join(root, 'dist/error-hints.cjs'));

test('classifies a refused CC Switch localhost endpoint as a stopped local proxy', () => {
  const hint = classifyCliError('API Error: Connection error. ECONNREFUSED 127.0.0.1:15721', {
    baseUrl: 'http://127.0.0.1:15721',
    baseUrlIsLocal: true,
    baseUrlListening: false
  });
  assert.equal(hint.kind, 'local-proxy-down');
  const text = errorHintText(hint, 'zh-CN');
  assert.match(text.title, /本地代理/);
  assert.match(text.nextStep, /CC Switch/);
});

test('classifies remote ECONNREFUSED separately from a stopped local proxy', () => {
  const hint = classifyCliError('connect ECONNREFUSED 198.51.100.9:443', {
    baseUrl: 'https://api.example.test', baseUrlIsLocal: false
  });
  assert.equal(hint.kind, 'connection-refused');
});

test('classifies authentication failures including invalid x-api-key', () => {
  for (const raw of ['HTTP 401 Unauthorized', 'HTTP 403 Forbidden', 'invalid x-api-key']) {
    assert.equal(classifyCliError(raw).kind, 'auth', raw);
  }
});

test('classifies rate limits, quota exhaustion and overloaded service', () => {
  for (const raw of ['HTTP 429 Too Many Requests', 'quota exceeded', 'API overloaded']) {
    assert.equal(classifyCliError(raw).kind, 'rate-limit', raw);
  }
});

test('classifies timeouts and DNS lookup failures as network errors', () => {
  for (const raw of ['ETIMEDOUT while connecting', 'ENOTFOUND api.example.test', 'getaddrinfo EAI_AGAIN api.example.test']) {
    assert.equal(classifyCliError(raw).kind, 'network', raw);
  }
});

test('classifies missing model responses', () => {
  for (const raw of ['model not found', 'not_found_error: model unavailable']) {
    assert.equal(classifyCliError(raw).kind, 'model-not-found', raw);
  }
});

test('unknown errors still get a useful retry hint', () => {
  const hint = classifyCliError('something unexpected happened');
  assert.equal(hint.kind, 'unknown');
  assert.ok(errorHintText(hint, 'zh-CN').title);
  assert.ok(errorHintText(hint, 'zh-CN').nextStep);
  assert.equal(hint.retryable, true);
});

test('classified error cards render from dictionary codes in both locales', () => {
  const local = classifyCliError('ECONNREFUSED', {
    baseUrl: 'http://127.0.0.1:15721', baseUrlIsLocal: true, baseUrlListening: false
  });
  assert.equal(local.code, 'localProxyAddress');
  const zh = errorHintText(local, 'zh-CN');
  const en = errorHintText(local, 'en');
  assert.equal(zh.title, '本地代理没有运行');
  assert.match(zh.detail, /127\.0\.0\.1:15721/);
  assert.match(zh.nextStep, /然后点「重试」/);
  assert.equal(en.title, 'Local proxy is not running');
  assert.match(en.detail, /127\.0\.0\.1:15721/);
  assert.match(en.nextStep, /Then retry\./);
  assert.doesNotMatch(JSON.stringify(en), /[\u3400-\u9fff]/u);

  const auth = classifyCliError('HTTP 401 Unauthorized');
  assert.equal(errorHintText(auth, 'zh-CN').detail, 'API 拒绝了当前的密钥或登录（401 / 403）。密钥可能无效、已过期，或没有权限使用这个模型。');
  assert.match(errorHintText(auth, 'en').detail, /API rejected the current key or login/);
});

test('synthetic labels are excluded while ordinary model ids remain usable', () => {
  assert.equal(isSyntheticModel('<synthetic>'), true);
  assert.equal(isSyntheticModel('  <SYNTHETIC>  '), true);
  assert.equal(isSyntheticModel('claude-sonnet-4-5'), false);
  assert.equal(isSyntheticModel('<custom-model>'), false);
  assert.equal(usableModel('<synthetic>'), undefined);
  assert.equal(usableModel('  '), undefined);
  assert.equal(usableModel(' claude-sonnet-4-5 '), 'claude-sonnet-4-5');
});

test('redacts URL credentials, query and fragment', () => {
  const redacted = redactUrl('https://alice:secret@example.test/v1?token=query-secret#fragment');
  assert.equal(redacted, 'https://example.test/v1');
  assert.doesNotMatch(redacted, /alice|secret|token|fragment/);
});

test('localEndpoint handles localhost, IPv4 loopback, IPv6 loopback and remote hosts', () => {
  assert.deepEqual(localEndpoint('http://localhost:15721/v1'), { host: '127.0.0.1', port: 15721 });
  assert.deepEqual(localEndpoint('http://127.0.0.1:15721'), { host: '127.0.0.1', port: 15721 });
  assert.deepEqual(localEndpoint('http://[::1]:15721'), { host: '::1', port: 15721 });
  assert.equal(localEndpoint('https://api.example.test'), undefined);
});
