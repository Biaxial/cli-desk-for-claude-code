/** Turn local drop paths into text the Claude CLI can read in the next user message. */

const MAX_DROPPED_PATHS = 20;

export function shouldBlockNavigation(currentUrl: string, nextUrl: string): boolean {
  if (!currentUrl || !nextUrl) return false;
  return nextUrl !== currentUrl;
}

export function pathFromFileUri(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed || trimmed.startsWith('#')) return '';
  let url: URL;
  try { url = new URL(trimmed); } catch { return ''; }
  if (url.protocol !== 'file:') return '';
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return ''; }
  if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
  return pathname.replace(/\//g, pathname.includes('\\') ? '\\' : (pathname.includes(':') ? '\\' : '/'));
}

export function formatDroppedPaths(paths: string[]): { text: string; omitted: number } {
  const usable = paths.map(path => path.trim()).filter(Boolean).slice(0, MAX_DROPPED_PATHS);
  const omitted = Math.max(0, paths.filter(path => path.trim()).length - usable.length);
  const text = usable.map(path => /[\s"]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path).join(' ');
  return { text, omitted };
}

export function insertPathSnippet(current: string, selectionStart: number, selectionEnd: number, snippet: string): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, current.length));
  const end = Math.max(start, Math.min(selectionEnd, current.length));
  const before = current.slice(0, start);
  const after = current.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  const value = before + lead + snippet + trail + after;
  return { value, caret: before.length + lead.length + snippet.length };
}
