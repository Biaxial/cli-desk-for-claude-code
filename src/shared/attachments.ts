import { t, type Locale, type TranslationKey } from './i18n';

export const MAX_ATTACHMENTS = 20;

export type AttachmentCategory = 'image' | 'code' | 'pdf' | 'office' | 'archive' | 'other';

export type AttachmentMetadata = {
  path: string;
  name: string;
  extension: string;
  category: AttachmentCategory;
  size: number;
  unsupported: boolean;
  extractionStatus?: 'extracted' | 'error';
  extractedCharacters?: number;
  tooltipCode?: TranslationKey;
  tooltipParams?: Record<string, string | number>;
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tif', '.tiff', '.heic', '.avif']);
const CODE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.ps1', '.sql', '.vue', '.svelte'
]);
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz']);

function usesWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

export function isAbsoluteAttachmentPath(value: string): boolean {
  if (usesWindowsPath(value)) return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
  return value.startsWith('/');
}

export function attachmentPathKey(value: string): string {
  if (usesWindowsPath(value)) {
    const normalized = value.replace(/\//g, '\\');
    const unc = normalized.startsWith('\\\\');
    const drive = /^([a-zA-Z]:)\\/.exec(normalized);
    let prefix = '';
    let segments: string[];
    if (unc) {
      const parts = normalized.slice(2).split(/\\+/).filter(Boolean);
      prefix = `\\\\${(parts.shift() || '').toLowerCase()}\\${(parts.shift() || '').toLowerCase()}`;
      segments = parts;
    } else if (drive) {
      prefix = `${drive[1].toLowerCase()}\\`;
      segments = normalized.slice(drive[0].length).split(/\\+/);
    } else {
      prefix = '\\';
      segments = normalized.replace(/^\\+/, '').split(/\\+/);
    }
    const clean: string[] = [];
    for (const segment of segments) {
      if (!segment || segment === '.') continue;
      if (segment === '..') clean.pop();
      else clean.push(segment);
    }
    return `${prefix}${clean.join('\\')}`.toLowerCase();
  }
  const clean: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') clean.pop();
    else clean.push(segment);
  }
  return `/${clean.join('/')}`;
}

export function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of paths) {
    const item = value.trim();
    if (!item) continue;
    const key = attachmentPathKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function dedupeAttachments(attachments: AttachmentMetadata[]): AttachmentMetadata[] {
  const seen = new Set<string>();
  const result: AttachmentMetadata[] = [];
  for (const attachment of attachments) {
    const key = attachmentPathKey(attachment.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(attachment);
  }
  return result;
}

export function attachmentExtension(filePath: string): string {
  const name = attachmentName(filePath);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function attachmentName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || filePath;
}

export function categorizeAttachment(filePath: string): AttachmentCategory {
  return categorizeAttachmentExtension(attachmentExtension(filePath));
}

export function categorizeAttachmentExtension(extension: string): AttachmentCategory {
  const normalized = extension.toLowerCase();
  if (IMAGE_EXTENSIONS.has(normalized)) return 'image';
  if (CODE_EXTENSIONS.has(normalized)) return 'code';
  if (normalized === '.pdf') return 'pdf';
  if (OFFICE_EXTENSIONS.has(normalized)) return 'office';
  if (ARCHIVE_EXTENSIONS.has(normalized)) return 'archive';
  return 'other';
}

export function unsupportedAttachmentTooltipCode(extension: string): TranslationKey | undefined {
  const ext = extension.toLowerCase();
  if (ext === '.doc') return 'attachment.tooltip.doc';
  if (['.xlsx', '.xls'].includes(ext)) return 'attachment.tooltip.excel';
  if (['.pptx', '.ppt'].includes(ext)) return 'attachment.tooltip.powerpoint';
  if (['.odt', '.ods', '.odp'].includes(ext)) return 'attachment.tooltip.openDocument';
  return undefined;
}

export function formatAttachmentSize(bytes: number, locale: Locale = 'zh-CN'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return t('chat.unknownSize', {}, locale);
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function quoteAttachmentPath(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function buildPromptWithAttachments(
  text: string,
  attachments: Pick<AttachmentMetadata, 'path'>[],
  locale: Locale = 'zh-CN'
): string {
  const prompt = text.trim() || (attachments.length > 0 ? t('prompt.attachmentsOnly', {}, locale) : '');
  if (attachments.length === 0) return prompt;
  const paths = dedupePaths(attachments.map(attachment => attachment.path));
  return `${prompt}\n\n${t('prompt.attachmentsHeader', {}, locale)}\n${paths.map(filePath => `- ${quoteAttachmentPath(filePath)}`).join('\n')}`;
}
