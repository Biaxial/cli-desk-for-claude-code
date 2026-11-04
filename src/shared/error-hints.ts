/** Classify raw CLI failures into locale-independent codes for renderer-time translation. */
import { t, type Locale, type TranslationKey } from './i18n';

export type ErrorKind =
  | 'local-proxy-down'
  | 'connection-refused'
  | 'auth'
  | 'rate-limit'
  | 'network'
  | 'model-not-found'
  | 'unknown';

export type ErrorHint = {
  kind: ErrorKind;
  code: ErrorHintCode;
  params: Record<string, string | number>;
  /** Whether resending the same message can succeed after the fix. */
  retryable: boolean;
  /** The original CLI text, trimmed, for a collapsed raw error section. */
  raw: string;
};

export type ErrorHintCode =
  | 'localProxy' | 'localProxyAddress'
  | 'refused' | 'refusedAddress'
  | 'auth' | 'authCredit'
  | 'rateLimited' | 'rateOverloaded'
  | 'modelNotFound'
  | 'network' | 'networkAddress'
  | 'unknown';

export type ErrorHintText = { title: string; detail: string; nextStep: string };

const hintTextKeys: Record<ErrorHintCode, [TranslationKey, TranslationKey, TranslationKey]> = {
  localProxy: ['errorHint.localProxy.title', 'errorHint.localProxy.detailDefault', 'errorHint.localProxy.next'],
  localProxyAddress: ['errorHint.localProxy.title', 'errorHint.localProxy.detailAddress', 'errorHint.localProxy.next'],
  refused: ['errorHint.refused.title', 'errorHint.refused.detailDefault', 'errorHint.refused.next'],
  refusedAddress: ['errorHint.refused.title', 'errorHint.refused.detailAddress', 'errorHint.refused.next'],
  auth: ['errorHint.auth.title', 'errorHint.auth.detail', 'errorHint.auth.next'],
  authCredit: ['errorHint.auth.creditTitle', 'errorHint.auth.creditDetail', 'errorHint.auth.creditNext'],
  rateLimited: ['errorHint.rate.title', 'errorHint.rate.detail', 'errorHint.rate.next'],
  rateOverloaded: ['errorHint.rate.overloadedTitle', 'errorHint.rate.overloadedDetail', 'errorHint.rate.next'],
  modelNotFound: ['errorHint.model.title', 'errorHint.model.detail', 'errorHint.model.next'],
  network: ['errorHint.network.title', 'errorHint.network.detailDefault', 'errorHint.network.next'],
  networkAddress: ['errorHint.network.title', 'errorHint.network.detailAddress', 'errorHint.network.next'],
  unknown: ['errorHint.unknown.title', 'errorHint.unknown.detail', 'errorHint.unknown.next'],
};

/** Resolve an already classified hint when rendering it in the current UI locale. */
export function errorHintText(hint: ErrorHint, locale: Locale): ErrorHintText {
  const [title, detail, nextStep] = hintTextKeys[hint.code];
  return {
    title: t(title, hint.params, locale),
    detail: t(detail, hint.params, locale),
    nextStep: t(nextStep, hint.params, locale),
  };
}

export type ErrorContext = {
  /** ANTHROPIC_BASE_URL with any credentials removed, if one is configured. */
  baseUrl?: string;
  /** True when baseUrl points at this machine (localhost, 127.x, ::1). */
  baseUrlIsLocal?: boolean;
  /** Result of probing the local port. undefined means not checked. */
  baseUrlListening?: boolean;
};

/** The CLI labels locally generated assistant messages (API errors, notices) with this model id. */
export const SYNTHETIC_MODEL = '<synthetic>';

export function isSyntheticModel(model: unknown): boolean {
  if (typeof model !== 'string') return false;
  const value = model.trim().toLowerCase();
  return value === SYNTHETIC_MODEL;
}

/** A usable model id for the picker, or undefined for empty / synthetic labels. */
export function usableModel(model: unknown): string | undefined {
  if (typeof model !== 'string') return undefined;
  const value = model.trim();
  if (!value || isSyntheticModel(value)) return undefined;
  return value;
}

/** Text the CLI prints as a whole assistant reply when the API call itself failed. */
export function looksLikeApiError(text: string): boolean {
  return /^\s*(API Error|Error:|Claude API error|Request failed)/i.test(text) || /\bAPI Error\b/.test(text);
}

/** Remove user:pass@ and query strings so a base URL can be shown or logged. */
export function redactUrl(value: string): string {
  const text = value.trim();
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return text.replace(/\/\/[^/@\s]*@/, '//').replace(/[?#].*$/, '');
  }
}

export function isLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** host / port for a local base URL, or undefined when it is remote or unparsable. */
export function localEndpoint(baseUrl: string | undefined): { host: string; port: number } | undefined {
  if (!baseUrl) return undefined;
  let url: URL;
  try { url = new URL(baseUrl); } catch { return undefined; }
  if (!isLocalHost(url.hostname)) return undefined;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  const host = bare === 'localhost' || bare === '0.0.0.0' ? '127.0.0.1' : bare;
  return { host, port };
}

const RAW_LIMIT = 400;

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > RAW_LIMIT ? `${clean.slice(0, RAW_LIMIT)}…` : clean;
}

function has(text: string, pattern: RegExp): boolean { return pattern.test(text); }

export function classifyCliError(rawText: string, context: ErrorContext = {}): ErrorHint {
  const text = typeof rawText === 'string' ? rawText : '';
  const raw = clip(text);
  const base = context.baseUrl ? redactUrl(context.baseUrl) : '';
  const localDown = !!context.baseUrlIsLocal && context.baseUrlListening === false;

  const refused = has(text, /ECONNREFUSED|Connection refused|connect ECONNREFUSED|拒绝连接|积极拒绝/i);
  const network = has(text, /ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|timeout|ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS|ENETUNREACH|EHOSTUNREACH|ECONNRESET|socket hang up|network error|fetch failed|Unable to connect|UND_ERR|certificate|SSL|TLS/i);

  if (localDown || (refused && context.baseUrlIsLocal)) {
    return {
      kind: 'local-proxy-down',
      code: base ? 'localProxyAddress' : 'localProxy',
      params: base ? { address: base } : {},
      retryable: true,
      raw,
    };
  }
  if (refused) {
    return {
      kind: 'connection-refused',
      code: base ? 'refusedAddress' : 'refused',
      params: base ? { address: base } : {},
      retryable: true,
      raw,
    };
  }
  if (has(text, /\b401\b|\b403\b|invalid[ _-]?(x-)?api[ _-]?key|authentication[ _-]?error|unauthori[sz]ed|forbidden|permission[ _-]?denied|OAuth token|token (has )?expired|please run \/login|Invalid bearer|credit balance is too low/i)) {
    const credit = has(text, /credit balance is too low/i);
    return {
      kind: 'auth',
      code: credit ? 'authCredit' : 'auth',
      params: {},
      retryable: true,
      raw,
    };
  }
  if (has(text, /\b429\b|rate[ _-]?limit|too many requests|quota|usage limit|limit reached|overloaded|\b529\b/i)) {
    const overloaded = has(text, /overloaded|\b529\b/i);
    return {
      kind: 'rate-limit',
      code: overloaded ? 'rateOverloaded' : 'rateLimited',
      params: {},
      retryable: true,
      raw,
    };
  }
  if (has(text, /model[^.\n]{0,40}not[ _-]?found|not_found_error|unknown model|invalid model|model .* (does not exist|is not available)|\b404\b.*model|model.*\b404\b/i)) {
    return {
      kind: 'model-not-found',
      code: 'modelNotFound',
      params: {},
      retryable: true,
      raw,
    };
  }
  if (network) {
    return {
      kind: 'network',
      code: base ? 'networkAddress' : 'network',
      params: base ? { address: base } : {},
      retryable: true,
      raw,
    };
  }
  return {
    kind: 'unknown',
    code: 'unknown',
    params: {},
    retryable: true,
    raw,
  };
}
