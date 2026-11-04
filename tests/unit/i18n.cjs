'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const { applyStaticTranslations, dictionaries, isDefaultSessionTitle, setI18nLocale, systemLocaleToLocale, t, zhCN } = require(path.join(root, 'dist/i18n.cjs'));

test('both dictionaries have the same non-empty keys and interpolation placeholders', () => {
  const zhKeys = Object.keys(zhCN).sort();
  const enKeys = Object.keys(dictionaries.en).sort();
  assert.deepEqual(enKeys, zhKeys);
  for (const key of zhKeys) {
    assert.equal(typeof dictionaries['zh-CN'][key], 'string', `${key} is not a Chinese string`);
    assert.ok(dictionaries['zh-CN'][key].trim(), `${key} is empty in Chinese`);
    assert.ok(dictionaries.en[key].trim(), `${key} is empty in English`);
    const placeholders = value => [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(dictionaries.en[key]), placeholders(dictionaries['zh-CN'][key]), `${key} placeholders differ`);
    if (!['settings.languageChinese', 'sidebar.quickLanguageLabel', 'sidebar.quickLanguageAria'].includes(key)) {
      assert.doesNotMatch(dictionaries.en[key], /[\u3400-\u9fff]/u, `${key} contains CJK in English`);
    }
  }
  assert.equal(t('settings.cliPathNote', { path: 'C:/Claude/claude.exe' }, 'en').includes('C:/Claude/claude.exe'), true);
});

test('system locale mapping prefers any Chinese hint and safely defaults to Chinese', () => {
  assert.equal(systemLocaleToLocale('en-US', ['fr-FR', 'zh-Hant']), 'zh-CN');
  assert.equal(systemLocaleToLocale('en-US', ['zhSomething']), 'zh-CN');
  assert.equal(systemLocaleToLocale('en_US', []), 'en');
  assert.equal(systemLocaleToLocale(undefined, ['en-GB']), 'en');
  assert.equal(systemLocaleToLocale(undefined, undefined), 'zh-CN');
  assert.equal(systemLocaleToLocale({}, ['??']), 'zh-CN');
});

test('default session titles are recognized in either locale', () => {
  assert.equal(isDefaultSessionTitle('新会话'), true);
  assert.equal(isDefaultSessionTitle('New session'), true);
  assert.equal(isDefaultSessionTitle('A real chat title'), false);
  assert.equal(isDefaultSessionTitle(undefined), false);
});

class FakeElement {
  constructor(attributes = {}, textContent = '') {
    this.attributes = new Map(Object.entries(attributes));
    this.textContent = textContent;
    this.children = [];
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  querySelectorAll(selector) {
    const names = [...selector.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
    const found = [];
    const visit = node => {
      if (names.some(name => node.getAttribute(name) !== null)) found.push(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return found;
  }
}

test('static translations reapply in place when switching English and Chinese', () => {
  const root = new FakeElement();
  const html = new FakeElement();
  root.documentElement = html;
  const button = new FakeElement({ 'data-i18n': 'sidebar.newChat' }, '新聊天');
  const search = new FakeElement({ 'data-i18n-placeholder': 'sidebar.searchPlaceholder' });
  const settings = new FakeElement({ 'data-i18n-title': 'sidebar.settings', 'data-i18n-aria': 'sidebar.settings' });
  root.children.push(button, search, settings);

  setI18nLocale('en');
  applyStaticTranslations(root);
  assert.equal(button.textContent, 'New chat');
  assert.equal(search.getAttribute('placeholder'), 'Search recent chats');
  assert.equal(settings.getAttribute('title'), 'Settings');
  assert.equal(settings.getAttribute('aria-label'), 'Settings');
  assert.equal(html.getAttribute('lang'), 'en');

  setI18nLocale('zh-CN');
  applyStaticTranslations(root);
  assert.equal(button.textContent, '新聊天');
  assert.equal(search.getAttribute('placeholder'), '搜索最近的聊天');
  assert.equal(settings.getAttribute('title'), '设置');
  assert.equal(settings.getAttribute('aria-label'), '设置');
  assert.equal(html.getAttribute('lang'), 'zh-CN');
  assert.equal(root.children[0], button, 'the same DOM element should be updated in place');
});
