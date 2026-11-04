const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const { ProjectRepository } = require(path.join(root, 'dist/project-repository.cjs'));

test('project storage persists outside repository and deduplicates directories', () => {
  const data = mkdtempSync(path.join(tmpdir(), 'cc-desktop-unit-'));
  const repository = new ProjectRepository(data);
  const one = repository.add(data);
  assert.equal(one.projects.length, 1);
  assert.equal(repository.add(data).projects.length, 1);
  assert.equal(new ProjectRepository(data).snapshot().activeProjectId, one.activeProjectId);
  assert.equal(repository.remove(one.activeProjectId).projects.length, 0);
  assert.ok(existsSync(path.join(data, 'settings.json')));
  assert.equal(new ProjectRepository(data).snapshot().language, 'zh-CN');
});

test('language settings persist, old settings remain loadable, and invalid values are rejected', () => {
  const data = mkdtempSync(path.join(tmpdir(), 'cc-desktop-language-'));
  const repository = new ProjectRepository(data, 'en');
  assert.equal(repository.snapshot().language, 'en');
  repository.setLanguage('zh-CN');
  assert.equal(new ProjectRepository(data, 'en').snapshot().language, 'zh-CN');
  assert.throws(() => repository.setLanguage('fr'), /应用语言无效/);

  const oldData = mkdtempSync(path.join(tmpdir(), 'cc-desktop-old-settings-'));
  writeFileSync(path.join(oldData, 'settings.json'), JSON.stringify({ schemaVersion: 1, cliPath: null, projects: [], activeProjectId: null }));
  assert.equal(new ProjectRepository(oldData, 'en').snapshot().language, 'en');
  assert.equal(JSON.parse(readFileSync(path.join(oldData, 'settings.json'), 'utf8')).language, undefined, 'loading old settings does not rewrite the file');

  const invalidData = mkdtempSync(path.join(tmpdir(), 'cc-desktop-invalid-language-'));
  writeFileSync(path.join(invalidData, 'settings.json'), JSON.stringify({ schemaVersion: 1, cliPath: null, projects: [], activeProjectId: null, language: 'fr' }));
  assert.throws(() => new ProjectRepository(invalidData), /应用设置无效/);
});
