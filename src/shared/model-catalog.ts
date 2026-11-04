/** Rows parsed from Claude CLI `/model` text. The app does not keep its own model list. */

export type ModelSection = 'default' | 'recommended';

export type CatalogModel = {
  id: string;
  label: string;
  section: ModelSection;
};

/** Print-mode probe. The prompt is the CLI slash command, not a second model API. */
export const MODEL_PROBE_ARGS = ['-p', '--output-format', 'text', '--tools', '', '/model'];

const DEFAULT_HEAD = /^(默认|default|defaults)$/i;
const RECOMMENDED_HEAD = /^(推荐模型集|推荐模型|推荐|recommended|recommended models)$/i;

function cleanLine(line: string): string {
  return line.replace(/^\uFEFF/, '').replace(/\t/g, ' ').trim();
}

function rowFromLine(line: string): { id: string; label: string; preferDefault: boolean } | null {
  let text = cleanLine(line).replace(/^(?:[-*•>–—]\s+|\d+[.)、]\s+)/, '').trim();
  if (!text || text.length > 80) return null;
  if (/[。！？]/.test(text)) return null;
  if (/^(usage|error|invalid|select model|选择模型|current model|当前模型|available models|可用模型)/i.test(text)) return null;
  if (text.split(/\s+/).length > 6) return null;
  const preferDefault = /\b(default|current)\b|默认|当前/.test(text);
  const wrapped = text.match(/^(.*?)\s*[（(]\s*([^()（）]+)\s*[)）]\s*$/);
  if (wrapped) {
    const outside = wrapped[1].replace(/\s*[—-]\s*$/, '').trim();
    const inside = wrapped[2].trim();
    const mark = /^(default|current|默认|当前)$/i.test(inside);
    const id = mark ? outside : inside;
    const label = mark ? outside : (outside || inside);
    if (!id) return null;
    return { id, label, preferDefault: preferDefault || mark };
  }
  text = text.replace(/\s+[—-]\s+.*$/, '').trim();
  if (!text || /[:：]/.test(text)) return null;
  return { id: text, label: text, preferDefault };
}

function dedupe(models: CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const model of models) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

function parsePlain(raw: string): CatalogModel[] {
  let section: ModelSection = 'recommended';
  let sawDefaultHead = false;
  const models: CatalogModel[] = [];
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const bare = cleanLine(line);
    if (!bare) continue;
    if (DEFAULT_HEAD.test(bare)) { section = 'default'; sawDefaultHead = true; continue; }
    if (RECOMMENDED_HEAD.test(bare)) { section = 'recommended'; continue; }
    const row = rowFromLine(line);
    if (!row) continue;
    const place: ModelSection = row.preferDefault || (section === 'default' && sawDefaultHead) ? 'default' : section;
    models.push({ id: row.id, label: row.label, section: row.preferDefault ? 'default' : place });
  }
  if (models.length > 0 && !models.some(model => model.section === 'default')) {
    models[0] = { ...models[0], section: 'default' };
  }
  return dedupe(models);
}

function resultText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.result === 'string') return record.result;
  return '';
}

/** Read a CLI transcript or plain `/model` printout into menu rows. */
export function parseModelCatalog(raw: string): CatalogModel[] {
  const text = raw.replace(/^\uFEFF/, '');
  const nested: CatalogModel[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const body = resultText(JSON.parse(trimmed));
      if (body) nested.push(...parsePlain(body));
    } catch { /* not a result line */ }
  }
  return dedupe(nested.length > 0 ? nested : parsePlain(text));
}
