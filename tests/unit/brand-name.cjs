'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dictionaries, zhCN } = require('../../dist/i18n.cjs');

const root = path.resolve(__dirname, '../..');
const oldBrandPatterns = [/\bcc desktop\b/gi, /\bcc-desktop\b/gi, /\bccdesktop\b/gi];

function sourceFiles(directory) {
  const acceptedExtensions = new Set(['.ts', '.html', '.css', '.js', '.cjs', '.cs', '.json']);
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(absolute));
    else if (acceptedExtensions.has(path.extname(entry.name))) found.push(absolute);
  }
  return found;
}

function stripDocumentedInternalIdentifiers(relativePath, content) {
  // Whitelist: LEGACY_PRODUCT_NAME for migration, legacy folder names in the resolver,
  // the ccDesktop preload bridge, and CCDesktop.Session native mutex.
  if (relativePath === 'src/shared/brand.ts') {
    content = content.replace(/^export const LEGACY_PRODUCT_NAME = 'CC Desktop';\r?\n/m, '');
  }
  if (relativePath === 'src/main/persistence/user-data-location.ts') {
    content = content.replace(/'cc-desktop'/g, '');
  }
  if (relativePath === 'src/native/windows/NativeSupervisor.cs') {
    content = content.replace(/CCDesktop\.Session/g, '');
  }
  return content.replace(/\bccDesktop\b/g, '');
}

function assertNoLegacyBrand(relativePath, content) {
  const scanned = stripDocumentedInternalIdentifiers(relativePath, content);
  for (const pattern of oldBrandPatterns) {
    assert.doesNotMatch(scanned, pattern, `legacy product name remains in ${relativePath}`);
  }
}

test('old product branding is absent from source, locale dictionaries, and the built renderer', () => {
  for (const absolute of sourceFiles(path.join(root, 'src'))) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    assertNoLegacyBrand(relative, fs.readFileSync(absolute, 'utf8'));
  }

  const localeStrings = [...Object.values(zhCN), ...Object.values(dictionaries.en)].join('\n');
  assertNoLegacyBrand('src/shared/i18n.ts dictionaries', localeStrings);

  const html = fs.readFileSync(path.join(root, 'dist/renderer/index.html'), 'utf8');
  assertNoLegacyBrand('dist/renderer/index.html', html);
  assert.match(html, /<title>CLI Desk for Claude Code<\/title>/);
});

test('the new product name and packaging metadata are consistent', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const productName = 'CLI Desk for Claude Code';
  assert.equal(packageJson.name, 'cli-desk-for-claude-code');
  assert.equal(packageJson.productName, productName);
  assert.equal(zhCN['settings.aboutTitle'], productName);
  assert.equal(dictionaries.en['settings.aboutTitle'], productName);

  const build = packageJson.build;
  assert.equal(build.appId, 'com.biaxialstudio.clidesk');
  assert.equal(build.productName, productName);
  assert.equal(build.win.executableName, 'CLIDesk');
  assert.equal(build.nsis.shortcutName, productName);
  assert.equal(build.nsis.uninstallDisplayName, productName);
  assert.equal(build.nsis.artifactName, 'CLI-Desk-for-Claude-Code-Setup-${version}.${ext}');
  assert.equal(build.portable.artifactName, 'CLI-Desk-for-Claude-Code-${version}-portable.${ext}');
  assert.match(packageJson.description, /unofficial/i);
});
