/**
 * Display formatting. Pure and browser-safe: no node imports, no locale detection.
 * Everything renders in en-US so screenshots and tests are stable.
 */

const LOCALE = 'en-US';

const money2 = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const money4 = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export interface MoneyOptions {
  /** force a fixed number of decimals instead of the adaptive rule */
  decimals?: number;
  /** render a leading `+` for positive values (deltas) */
  signed?: boolean;
}

/**
 * `$1,234.56`; under a cent switches to 4 decimals; under $0.0001 collapses to `<$0.0001`.
 * Exact zero is always `$0.00` so tables do not fill with `<$0.0001`.
 */
export function formatMoney(usd: number, opts: MoneyOptions = {}): string {
  if (!Number.isFinite(usd)) return '—';
  const sign = usd < 0 ? '-' : opts.signed && usd > 0 ? '+' : '';
  const abs = Math.abs(usd);
  if (opts.decimals !== undefined) {
    const fmt = new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: opts.decimals,
      maximumFractionDigits: opts.decimals,
    });
    return sign + fmt.format(abs);
  }
  if (abs === 0) return '$0.00';
  if (abs < 0.0001) return `${sign}<$0.0001`;
  if (abs < 0.01) return sign + money4.format(abs);
  return sign + money2.format(abs);
}

/** `$1.2k`, `$3.4M`; small values fall through to {@link formatMoney}. */
export function formatMoneyCompact(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  const sign = usd < 0 ? '-' : '';
  const abs = Math.abs(usd);
  if (abs >= 1_000_000) return `${sign}$${oneDecimal.format(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${oneDecimal.format(abs / 1_000)}k`;
  return formatMoney(usd);
}

/** `1,234`, `12.3k`, `1.2M`. Use {@link formatTokensFull} for the tooltip/title. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${oneDecimal.format(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}${oneDecimal.format(abs / 1_000)}k`;
  return sign + integer.format(Math.round(abs));
}

/** The exact grouped token count, for `title`/`aria-label` next to {@link formatTokens}. */
export function formatTokensFull(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${integer.format(Math.round(n))} tokens`;
}

/** `fraction` is 0..1. `formatPercent(0.1234)` → `12.3%`. */
export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return '—';
  const fmt = new Intl.NumberFormat(LOCALE, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return fmt.format(fraction);
}

/** `820ms`, `4.2s`, `3m 5s`, `1h 12m`, `2d 3h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${oneDecimal.format(seconds)}s`;
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${Math.floor(seconds % 60)}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
}

const dateFmt = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const monthFmt = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });

function toDate(value: string | number | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `Sep 7, 2026` */
export function formatDate(value: string | number | Date): string {
  const d = toDate(value);
  return d ? dateFmt.format(d) : '—';
}

/** `14:05` */
export function formatTime(value: string | number | Date): string {
  const d = toDate(value);
  return d ? timeFmt.format(d) : '—';
}

/** `Sep 7, 2026, 14:05` */
export function formatDateTime(value: string | number | Date): string {
  const d = toDate(value);
  return d ? dateTimeFmt.format(d) : '—';
}

/** `2026-09` → `September 2026` (parsed as a local date, never UTC-shifted). */
export function formatMonthKey(month: string): string {
  const parts = month.split('-');
  const year = Number(parts[0]);
  const monthIndex = Number(parts[1]) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex)) return month;
  return monthFmt.format(new Date(year, monthIndex, 1));
}

const FAMILY_LABELS: Record<string, string> = {
  fable: 'Fable',
  mythos: 'Mythos',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

const GEMINI_TIERS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

function formatGeminiWord(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

function formatGeminiLabel(id: string): string {
  const parts = id.replace(/^(?:google|models|vertex_ai)\//, '').replace(/^gemini-/, '').split('-').filter(Boolean);
  if (parts.length === 0) return 'Gemini';
  const last = parts[parts.length - 1]!;
  const tier = parts.length > 1 ? GEMINI_TIERS[last] : undefined;
  const core = tier ? parts.slice(0, -1) : parts;
  const words: string[] = ['Gemini'];
  for (let i = 0; i < core.length; i += 1) {
    const token = core[i]!;
    if (token === 'flash' && core[i + 1] === 'lite') {
      words.push('Flash-Lite');
      i += 1;
    } else if (/^\d/.test(token)) {
      words.push(token);
    } else {
      words.push(formatGeminiWord(token));
    }
  }
  return tier ? `${words.join(' ')} (${tier})` : words.join(' ');
}

/**
 * `claude-haiku-4-5-20251001` → `Haiku 4.5`, `claude-opus-5[1m]` → `Opus 5 (1M)`,
 * `gemini-4-carbon-medium` → `Gemini 4 Carbon (Medium)`.
 * Falls back to the raw id when it does not look like a Claude or Gemini model id.
 */
export function formatModelLabel(modelId: string): string {
  const raw = modelId.trim().toLowerCase();
  if (raw === '' ) return '—';
  if (raw.includes('synthetic')) return 'Synthetic';
  const longContext = raw.includes('[1m]');
  let id = raw.replace('[1m]', '');
  const at = id.indexOf('@');
  if (at >= 0) id = id.slice(0, at);
  if (/^(?:(?:google|models|vertex_ai)\/)?gemini-/.test(id)) return formatGeminiLabel(id);
  id = id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const parts = id.split('-').filter((p) => p.length > 0);
  const familyIndex = parts.findIndex((p) => FAMILY_LABELS[p] !== undefined);
  if (familyIndex < 0) return modelId;
  const family = FAMILY_LABELS[parts[familyIndex] ?? ''] ?? modelId;
  const version = parts.filter((_, i) => i !== familyIndex).join('.');
  const base = version ? `${family} ${version}` : family;
  return longContext ? `${base} (1M)` : base;
}

/** Escapes text for safe interpolation into HTML snippets. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pluralize a noun by count: `plural(1, 'request')` → "1 request", `plural(4, 'request')` →
 * "4 requests", `plural(0, 'session')` → "0 sessions". Pass an explicit plural form for
 * irregular nouns. The count is formatted with thousands separators.
 */
export function plural(n: number, singular: string, pluralForm?: string): string {
  const word = n === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${new Intl.NumberFormat('en-US').format(n)} ${word}`;
}

/** The noun alone, pluralized by count — for sentences that already print the number. */
export function pluralNoun(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : (pluralForm ?? `${singular}s`);
}
