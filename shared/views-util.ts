/**
 * The small coercions every view's normalizer shares: an agent sends text
 * where a number belongs, a price as "184,50 €", a link that is not https.
 * Kept apart from `views.ts` so each view kind can live in a file of its own
 * without importing the union that imports it.
 */
export const MAX_TEXT = 400;
export const MAX_TITLE = 140;
const MAX_LIST = 8;

export const str = (v: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const strList = (v: unknown, max = MAX_LIST): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => str(x)).filter((x): x is string => !!x).slice(0, max);
  return out.length ? out : undefined;
};

/** "184 EUR", "184,50" -> 184.5. A price written as text is the common case. */
export function parseAmount(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const m = v.replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

export function currencyOf(v: unknown): string {
  const s = str(v, 8);
  if (!s) return 'EUR';
  if (s === '€') return 'EUR';
  if (s === '$') return 'USD';
  if (s === '£') return 'GBP';
  return s.toUpperCase();
}

export interface ViewPrice { amount: number; currency: string; note?: string }

/** A price in any of the three shapes an agent sends: number, text, object. */
export function priceOf(p: unknown, fallbackNote?: unknown): ViewPrice | undefined {
  const pObj = (p && typeof p === 'object' ? p : null) as Record<string, unknown> | null;
  const amount = parseAmount(pObj ? pObj.amount : p);
  if (amount === undefined) return undefined;
  const price: ViewPrice = {
    amount,
    currency: currencyOf(pObj?.currency ?? (typeof p === 'string' && p.includes('$') ? '$' : undefined)),
  };
  const note = str(pObj?.note ?? fallbackNote, 80);
  if (note) price.note = note;
  return price;
}

/** Only what a page may load: http(s), an absolute local path (served via /api/media), or /uploads/. */
export function imageSrc(v: unknown): string | undefined {
  const s = str(v, 2048);
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('file://')) return decodeURIComponent(s.slice('file://'.length).replace(/^localhost/, ''));
  if (s.startsWith('/')) return s;
  return undefined;
}

export function linkUrl(v: unknown): string | undefined {
  const s = str(v, 2048);
  return s && /^https?:\/\//i.test(s) ? s : undefined;
}

/** `{url, label}` or a bare URL; null when it is not https. */
export function linkOf(v: unknown): { url: string; label?: string } | undefined {
  const lo = (v && typeof v === 'object' ? v : null) as Record<string, unknown> | null;
  const url = linkUrl(lo ? lo.url : v);
  if (!url) return undefined;
  const label = str(lo?.label, 40);
  return label ? { url, label } : { url };
}

export const asRecord = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
