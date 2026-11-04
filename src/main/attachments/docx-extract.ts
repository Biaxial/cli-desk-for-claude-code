import { readFileSync, statSync } from 'node:fs';
import mammoth = require('mammoth');
import { DOMParser } from '@xmldom/xmldom';
import { t, type Locale, type TranslationKey } from '../../shared/i18n';

export const MAX_DOCX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_DOCX_TEXT_CHARACTERS = 200_000;

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export type DocxErrorCode = 'corrupt' | 'encrypted' | 'empty' | 'tooLarge' | 'notFound' | 'notFile';
const docxErrorKeys: Record<DocxErrorCode, TranslationKey> = {
  corrupt: 'docx.corrupt', encrypted: 'docx.encrypted', empty: 'docx.empty',
  tooLarge: 'docx.tooLarge', notFound: 'docx.notFound', notFile: 'docx.notFile',
};

export function docxErrorText(code: DocxErrorCode, params: Record<string, string | number> = {}, locale: Locale = 'zh-CN'): string {
  return t(docxErrorKeys[code], params, locale);
}

export class DocxExtractionError extends Error {
  readonly code: DocxErrorCode;
  readonly params: Record<string, string | number>;

  constructor(code: DocxErrorCode, params: Record<string, string | number> = {}, locale: Locale = 'zh-CN') {
    super(docxErrorText(code, params, locale));
    this.name = 'DocxExtractionError';
    this.code = code;
    this.params = params;
  }
}

function nodeTag(node: Node): string {
  return node.nodeType === 1 ? node.nodeName.toLowerCase() : '';
}

function childNodes(node: Node): Node[] {
  const result: Node[] = [];
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index);
    if (child) result.push(child);
  }
  return result;
}

function inlineMarkdown(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue || '';
  const tag = nodeTag(node);
  if (tag === 'img') return '';
  const contents = childNodes(node).map(inlineMarkdown).join('');
  if (tag === 'strong' || tag === 'b') return `**${contents}**`;
  if (tag === 'em' || tag === 'i') return `*${contents}*`;
  if (tag === 'code') return `\`${contents}\``;
  if (tag === 'br') return '\n';
  return contents;
}

function tableRows(table: Node): string[][] {
  const rows: string[][] = [];
  const visit = (node: Node): void => {
    for (const child of childNodes(node)) {
      if (nodeTag(child) === 'table') continue;
      if (nodeTag(child) === 'tr') {
        const cells = childNodes(child)
          .filter(cell => ['td', 'th'].includes(nodeTag(cell)))
          .map(cell => inlineMarkdown(cell).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
        if (cells.length > 0) rows.push(cells);
      } else {
        visit(child);
      }
    }
  };
  visit(table);
  return rows;
}

function renderList(list: Node, depth = 0): string[] {
  const ordered = nodeTag(list) === 'ol';
  const lines: string[] = [];
  let itemNumber = 1;
  for (const item of childNodes(list).filter(child => nodeTag(child) === 'li')) {
    const nestedLists = childNodes(item).filter(child => ['ul', 'ol'].includes(nodeTag(child)));
    const body = childNodes(item)
      .filter(child => !['ul', 'ol'].includes(nodeTag(child)))
      .map(child => inlineMarkdown(child))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    const marker = ordered ? `${itemNumber}.` : '-';
    if (body) lines.push(`${'  '.repeat(depth)}${marker} ${body}`);
    else lines.push(`${'  '.repeat(depth)}${marker}`);
    itemNumber += 1;
    for (const nested of nestedLists) lines.push(...renderList(nested, depth + 1));
  }
  return lines;
}

function blocksMarkdown(node: Node): string[] {
  const blocks: string[] = [];
  for (const child of childNodes(node)) {
    const tag = nodeTag(child);
    if (tag === 'img') continue;
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const value = inlineMarkdown(child).trim();
      if (value) blocks.push(`${'#'.repeat(level)} ${value}`);
    } else if (tag === 'p') {
      const value = inlineMarkdown(child).trim();
      if (value) blocks.push(value);
    } else if (tag === 'ul' || tag === 'ol') {
      const value = renderList(child).join('\n');
      if (value) blocks.push(value);
    } else if (tag === 'table') {
      const rows = tableRows(child);
      if (rows.length > 0) {
        const width = Math.max(...rows.map(row => row.length));
        const markdownRows = rows.map(row => `| ${Array.from({ length: width }, (_, index) => row[index] || '').join(' | ')} |`);
        const divider = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
        blocks.push([markdownRows[0], divider, ...markdownRows.slice(1)].join('\n'));
      }
    } else if (tag === 'blockquote') {
      const value = blocksMarkdown(child).join('\n\n');
      if (value) blocks.push(value.split('\n').map(line => `> ${line}`).join('\n'));
    } else {
      const nested = blocksMarkdown(child);
      if (nested.length > 0) blocks.push(...nested);
      else {
        const value = inlineMarkdown(child).trim();
        if (value) blocks.push(value);
      }
    }
  }
  return blocks;
}

function htmlToMarkdown(html: string): string {
  // Mammoth generates a small, well-formed HTML subset. Wrapping it provides an
  // XML root so DOMParser can safely decode entities without enabling HTML features.
  const document = new DOMParser().parseFromString(`<root>${html}</root>`, 'text/xml');
  const root = document.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'root') throw new Error('invalid conversion output');
  return blocksMarkdown(root).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isCompoundFile(buffer: Buffer): boolean {
  return buffer.length >= CFB_SIGNATURE.length && buffer.subarray(0, CFB_SIGNATURE.length).equals(CFB_SIGNATURE);
}

function hasZipSignature(buffer: Buffer): boolean {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  return (buffer[2] === 0x03 && buffer[3] === 0x04)
    || (buffer[2] === 0x05 && buffer[3] === 0x06)
    || (buffer[2] === 0x07 && buffer[3] === 0x08);
}

export type DocxExtractionOptions = { maxCharacters?: number; locale?: Locale };

/** Reads a local .docx as bytes so non-ASCII Windows and POSIX paths are preserved. */
export async function extractDocxText(filePath: string, options: DocxExtractionOptions = {}): Promise<string> {
  const locale = options.locale ?? 'zh-CN';
  let size: number;
  try {
    const info = statSync(filePath);
    if (!info.isFile()) throw new DocxExtractionError('notFile', {}, locale);
    size = info.size;
  } catch (error) {
    if (error instanceof DocxExtractionError) throw error;
    throw new DocxExtractionError('notFound', {}, locale);
  }
  if (size > MAX_DOCX_FILE_BYTES) {
    throw new DocxExtractionError('tooLarge', { maxMb: Math.round(MAX_DOCX_FILE_BYTES / 1024 / 1024) }, locale);
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    throw new DocxExtractionError('notFound', {}, locale);
  }
  if (isCompoundFile(buffer)) throw new DocxExtractionError('encrypted', {}, locale);
  if (!hasZipSignature(buffer)) throw new DocxExtractionError('corrupt', {}, locale);

  let fullText: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer },
      { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) }
    );
    fullText = htmlToMarkdown(result.value);
  } catch {
    throw new DocxExtractionError('corrupt', {}, locale);
  }

  if (!fullText.trim()) throw new DocxExtractionError('empty', {}, locale);
  const maxCharacters = Number.isFinite(options.maxCharacters)
    ? Math.max(0, Math.floor(options.maxCharacters!))
    : MAX_DOCX_TEXT_CHARACTERS;
  if (fullText.length <= maxCharacters) return fullText;
  return `${fullText.slice(0, maxCharacters)}\n\n${t('docx.truncated', { maxCharacters, originalCharacters: fullText.length }, locale)}`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Keeps document text inside its block and prevents nested attachment tags. */
export function buildDocxAttachmentBlock(name: string, filePath: string, text: string): string {
  const safeText = text
    .replace(/<\s*\/\s*attachment\s*>/gi, '&lt;/attachment&gt;')
    .replace(/<\s*attachment(?=[\s>])/gi, '&lt;attachment');
  return `<attachment name="${escapeAttribute(name)}" path="${escapeAttribute(filePath)}">\n${safeText}\n</attachment>`;
}

export type DocxPromptAttachment = { name: string; path: string };
export type DocxTextExtractor = (attachment: DocxPromptAttachment, maxCharacters: number) => Promise<string>;

/** Builds bounded document blocks. Once the shared budget is exhausted, later files are not read. */
export async function buildDocxPromptSection(
  attachments: DocxPromptAttachment[],
  extract: DocxTextExtractor,
  maxCharacters = MAX_DOCX_TEXT_CHARACTERS,
  locale: Locale = 'zh-CN'
): Promise<string> {
  const blocks: string[] = [];
  let remainingCharacters = Math.max(0, Math.floor(maxCharacters));
  for (const attachment of attachments) {
    if (remainingCharacters <= 0) {
      blocks.push(buildDocxAttachmentBlock(
        attachment.name,
        attachment.path,
        t('docx.combinedTruncated', { maxCharacters: Math.max(0, Math.floor(maxCharacters)) }, locale)
      ));
      continue;
    }
    try {
      const extracted = await extract(attachment, remainingCharacters);
      blocks.push(buildDocxAttachmentBlock(attachment.name, attachment.path, extracted));
      remainingCharacters = Math.max(0, remainingCharacters - extracted.length);
    } catch (error) {
      const reason = error instanceof DocxExtractionError
        ? docxErrorText(error.code, error.params, locale)
        : docxErrorText('corrupt', {}, locale);
      blocks.push(buildDocxAttachmentBlock(
        attachment.name,
        attachment.path,
        t('docx.sendFailure', { reason: reason.replace(/\.$/, '') }, locale)
      ));
    }
  }
  return blocks.length > 0 ? `${t('docx.promptHeader', {}, locale)}\n${blocks.join('\n\n')}` : '';
}
