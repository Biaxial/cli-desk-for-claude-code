'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const {
  MAX_ATTACHMENTS,
  attachmentExtension,
  attachmentName,
  attachmentPathKey,
  buildPromptWithAttachments,
  categorizeAttachment,
  dedupeAttachments,
  dedupePaths,
  formatAttachmentSize,
  isAbsoluteAttachmentPath,
  unsupportedAttachmentTooltipCode
} = require(path.join(root, 'dist/attachments.cjs'));
const { t } = require(path.join(root, 'dist/i18n.cjs'));

test('attachment categories and Windows paths are handled independently of the host OS', () => {
  const filePath = 'C:\\Users\\A User\\notes.TS';
  assert.equal(isAbsoluteAttachmentPath(filePath), true);
  assert.equal(attachmentName(filePath), 'notes.TS');
  assert.equal(attachmentExtension(filePath), '.ts');
  assert.equal(categorizeAttachment(filePath), 'code');
  assert.equal(categorizeAttachment('\\\\server\\share\\photo.PNG'), 'image');
  assert.equal(categorizeAttachment('C:\\work\\deck.pptx'), 'office');
  assert.equal(categorizeAttachment('/tmp/archive.zip'), 'archive');
  assert.equal(isAbsoluteAttachmentPath('relative\\notes.txt'), false);
});

test('paths and attachment records are deduplicated with Windows case and separator rules', () => {
  assert.equal(attachmentPathKey('C:\\Users\\Ada\\a.ts'), attachmentPathKey('c:/users/ada/./a.ts'));
  assert.deepEqual(dedupePaths(['C:\\work\\a.ts', 'c:/WORK/a.ts', '/tmp/a.ts']), ['C:\\work\\a.ts', '/tmp/a.ts']);
  const records = [
    { path: 'C:\\work\\a.ts', name: 'a.ts' },
    { path: 'c:/WORK/a.ts', name: 'duplicate.ts' }
  ];
  assert.equal(dedupeAttachments(records).length, 1);
  assert.equal(MAX_ATTACHMENTS, 20);
});

test('attachment prompts list quoted absolute paths and provide a default for attachment-only sends', () => {
  const attachments = [
    { path: 'C:\\Users\\Ada\\My Notes\\draft.md' },
    { path: 'C:\\work\\a.ts' },
    { path: 'C:\\work\\a.ts' }
  ];
  assert.equal(
    buildPromptWithAttachments('请总结一下', attachments),
    '请总结一下\n\n附件:\n- "C:\\Users\\Ada\\My Notes\\draft.md"\n- C:\\work\\a.ts'
  );
  assert.equal(buildPromptWithAttachments('  ', [attachments[1]]), '请查看这些附件。\n\n附件:\n- C:\\work\\a.ts');
  assert.equal(buildPromptWithAttachments('  ', [attachments[1]]), '请查看这些附件。\n\n附件:\n- C:\\work\\a.ts');
  assert.equal(buildPromptWithAttachments('  ', [attachments[1]], 'en'), 'Please review these attachments.\n\nAttachments:\n- C:\\work\\a.ts');
  assert.equal(buildPromptWithAttachments('只发文本', []), '只发文本');
});

test('file sizes are human-readable and unsupported office formats have clear Chinese guidance', () => {
  assert.equal(formatAttachmentSize(42), '42 B');
  assert.equal(formatAttachmentSize(1536), '1.5 KB');
  assert.equal(formatAttachmentSize(2 * 1024 * 1024), '2.0 MB');
  assert.match(t(unsupportedAttachmentTooltipCode('.xlsx'), {}, 'zh-CN'), /另存为 \.csv/);
  assert.equal(unsupportedAttachmentTooltipCode('.pdf'), undefined);
  assert.equal(unsupportedAttachmentTooltipCode('.docx'), undefined);
  assert.match(t(unsupportedAttachmentTooltipCode('.doc'), {}, 'zh-CN'), /旧版 \.doc 格式无法直接读取/);
  assert.equal(unsupportedAttachmentTooltipCode('.ts'), undefined);
  const excel = unsupportedAttachmentTooltipCode('.xlsx');
  const legacyWord = unsupportedAttachmentTooltipCode('.doc');
  assert.equal(t(excel, {}, 'en'), 'This version does not extract Excel spreadsheets. The file path will still be sent; save it as .csv or paste the text you want analyzed.');
  assert.equal(t(legacyWord, {}, 'en'), 'Legacy .doc files cannot be read directly. Save the file as .docx in Word, then attach it again.');
  assert.doesNotMatch(t(excel, {}, 'en'), /[\u3400-\u9fff]/u);
});
