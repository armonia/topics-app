/**
 * Generative views: the agent sends DATA, Topics draws it.
 *
 * Why it exists. To show a comparison (three stays with photos, prices and
 * walking times, topic:64095902) an agent used to hand-write an HTML page under
 * `~/.topics/media/<something>/index.html` and open it in the browser pane: a
 * different design every time, invented CSS, no dark theme, no phone layout.
 * Here the contract is inverted: the agent calls `show_view` with typed data,
 * and the same data becomes a block in the chat and a standalone page at
 * `/v/<id>`, both drawn by the client's own components.
 *
 * This file is the contract shared by the three sides (MCP tool, server route,
 * renderer): shape, limits, normalization and the few pure rules (who wins on
 * a metric). No DOM, no fs.
 */
import { z } from 'zod/mini';

/** The views the catalogue knows. One today; the union grows a member per view. */
export const VIEW_KINDS = ['compare'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

// Limits. Not cosmetic: they keep the view readable and the payload small (the
// detail travels in every WS frame and in every history row).
export const COMPARE_MIN_OPTIONS = 2;
export const COMPARE_MAX_OPTIONS = 4;
const MAX_IMAGES = 12;
const MAX_LIST = 8;
const MAX_METRICS = 8;
const MAX_TEXT = 400;
const MAX_TITLE = 140;

const metricSchema = z.object({
  label: z.string(),
  value: z.union([z.number(), z.string()]),
  unit: z.optional(z.string()),
  better: z.optional(z.enum(['lower', 'higher'])),
});

const compareOptionSchema = z.object({
  title: z.string(),
  subtitle: z.optional(z.string()),
  price: z.optional(z.object({
    amount: z.number(),
    currency: z.string(),
    note: z.optional(z.string()),
  })),
  images: z.optional(z.array(z.object({ src: z.string(), caption: z.optional(z.string()) }))),
  pros: z.optional(z.array(z.string())),
  cons: z.optional(z.array(z.string())),
  metrics: z.optional(z.array(metricSchema)),
  link: z.optional(z.object({ url: z.string(), label: z.optional(z.string()) })),
  recommended: z.optional(z.boolean()),
});

const compareViewSchema = z.object({
  view: z.literal('compare'),
  title: z.string(),
  subtitle: z.optional(z.string()),
  verdict: z.optional(z.string()),
  options: z.array(compareOptionSchema),
});

/** The NORMALIZED shape: what `normalizeViewSpec` returns and what renderers read. */
export const viewSpecSchema = z.discriminatedUnion('view', [compareViewSchema]);

export type ViewMetric = z.infer<typeof metricSchema>;
export type CompareOption = z.infer<typeof compareOptionSchema>;
export type CompareViewSpec = z.infer<typeof compareViewSchema>;
export type ViewSpec = z.infer<typeof viewSpecSchema>;

export type NormalizeResult = { ok: true; spec: ViewSpec } | { ok: false; errors: string[] };

const str = (v: unknown, max = MAX_TEXT): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const strList = (v: unknown, max = MAX_LIST): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => str(x)).filter((x): x is string => !!x).slice(0, max);
  return out.length ? out : undefined;
};

/** "184 EUR", "184,50" -> 184.5. A price written as text is the common case. */
function parseAmount(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const m = v.replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

function currencyOf(v: unknown): string {
  const s = str(v, 8);
  if (!s) return 'EUR';
  if (s === '€') return 'EUR';
  if (s === '$') return 'USD';
  if (s === '£') return 'GBP';
  return s.toUpperCase();
}

/** Only what a page may load: http(s), an absolute local path (served via /api/media), or /uploads/. */
function imageSrc(v: unknown): string | undefined {
  const s = str(v, 2048);
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('file://')) return decodeURIComponent(s.slice('file://'.length).replace(/^localhost/, ''));
  if (s.startsWith('/')) return s;
  return undefined;
}

function linkUrl(v: unknown): string | undefined {
  const s = str(v, 2048);
  return s && /^https?:\/\//i.test(s) ? s : undefined;
}

function normalizeCompare(raw: Record<string, unknown>, errors: string[]): CompareViewSpec | null {
  const title = str(raw.title, MAX_TITLE);
  if (!title) errors.push("'title' (string) is required");
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  if (rawOptions.length < COMPARE_MIN_OPTIONS || rawOptions.length > COMPARE_MAX_OPTIONS) {
    errors.push(`'options' must have ${COMPARE_MIN_OPTIONS}-${COMPARE_MAX_OPTIONS} items (got ${rawOptions.length})`);
  }
  const options: CompareOption[] = [];
  rawOptions.slice(0, COMPARE_MAX_OPTIONS).forEach((o, i) => {
    const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
    const otitle = str(r.title, MAX_TITLE);
    if (!otitle) { errors.push(`options[${i}].title (string) is required`); return; }
    const opt: CompareOption = { title: otitle };
    const subtitle = str(r.subtitle);
    if (subtitle) opt.subtitle = subtitle;
    // A price comes in three shapes: number, text ("184 EUR"), object.
    const p = r.price;
    const pObj = (p && typeof p === 'object' ? p : null) as Record<string, unknown> | null;
    const amount = parseAmount(pObj ? pObj.amount : p);
    if (amount !== undefined) {
      opt.price = { amount, currency: currencyOf(pObj?.currency ?? r.currency ?? (typeof p === 'string' && p.includes('$') ? '$' : undefined)) };
      const note = str(pObj?.note ?? r.price_note ?? r.priceNote, 80);
      if (note) opt.price.note = note;
    }
    if (Array.isArray(r.images)) {
      const images = r.images
        .map((im) => {
          const io = (im && typeof im === 'object' ? im : null) as Record<string, unknown> | null;
          const src = imageSrc(io ? io.src ?? io.url : im);
          if (!src) return null;
          const caption = str(io?.caption ?? io?.alt, 80);
          return caption ? { src, caption } : { src };
        })
        .filter((x): x is { src: string; caption?: string } => !!x)
        .slice(0, MAX_IMAGES);
      if (images.length) opt.images = images;
    }
    const pros = strList(r.pros);
    if (pros) opt.pros = pros;
    const cons = strList(r.cons);
    if (cons) opt.cons = cons;
    if (Array.isArray(r.metrics)) {
      const metrics = r.metrics
        .map((m): ViewMetric | null => {
          const mo = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
          const label = str(mo.label, 40);
          const value = typeof mo.value === 'number' && Number.isFinite(mo.value) ? mo.value : str(mo.value, 40);
          if (!label || value === undefined) return null;
          const out: ViewMetric = { label, value };
          const unit = str(mo.unit, 12);
          if (unit) out.unit = unit;
          if (mo.better === 'lower' || mo.better === 'higher') out.better = mo.better;
          return out;
        })
        .filter((x): x is ViewMetric => !!x)
        .slice(0, MAX_METRICS);
      if (metrics.length) opt.metrics = metrics;
    }
    const lo = (r.link && typeof r.link === 'object' ? r.link : null) as Record<string, unknown> | null;
    const url = linkUrl(lo ? lo.url : r.link ?? r.url);
    if (url) {
      const label = str(lo?.label, 40);
      opt.link = label ? { url, label } : { url };
    }
    if (r.recommended === true) opt.recommended = true;
    options.push(opt);
  });
  // One recommendation at most: a second one recommends nothing.
  const rec = options.filter((o) => o.recommended);
  if (rec.length > 1) errors.push(`at most one option may be 'recommended' (got ${rec.length})`);
  if (errors.length || !title) return null;
  const spec: CompareViewSpec = { view: 'compare', title, options };
  const subtitle = str(raw.subtitle);
  if (subtitle) spec.subtitle = subtitle;
  const verdict = str(raw.verdict);
  if (verdict) spec.verdict = verdict;
  return spec;
}

/**
 * Validate and normalize what an agent sent. Errors are written FOR THE AGENT:
 * they come back as the tool's error text, so it can fix the call and retry.
 */
export function normalizeViewSpec(input: unknown): NormalizeResult {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind = raw.view ?? 'compare';
  const errors: string[] = [];
  if (kind !== 'compare') return { ok: false, errors: [`unknown view '${String(kind)}' (known: ${VIEW_KINDS.join(', ')})`] };
  const spec = normalizeCompare(raw, errors);
  return spec ? { ok: true, spec } : { ok: false, errors };
}

/** Parse an already-normalized spec (from a stored row or a WS frame). */
export function parseViewSpec(value: unknown): ViewSpec | null {
  const r = viewSpecSchema.safeParse(value);
  return r.success ? (r.data as ViewSpec) : null;
}

// Metrics: who wins.

export type MetricRank = 'best' | 'worst' | undefined;

/**
 * For each option and metric label: is it the best or the worst among the
 * options? Only for metrics with `better` set, numeric in at least two
 * options, and not all equal. Ties share the rank. Pure.
 */
export function rankMetrics(options: readonly CompareOption[]): Array<Record<string, MetricRank>> {
  const ranks: Array<Record<string, MetricRank>> = options.map(() => ({}));
  const labels = new Set<string>();
  for (const o of options) for (const m of o.metrics ?? []) if (m.better) labels.add(m.label);
  for (const label of labels) {
    const vals = options.map((o) => {
      const m = o.metrics?.find((x) => x.label === label);
      return m && typeof m.value === 'number' ? { v: m.value, better: m.better } : null;
    });
    const nums = vals.filter((x): x is { v: number; better: 'lower' | 'higher' | undefined } => !!x);
    if (nums.length < 2) continue;
    const better = nums.find((x) => x.better)?.better ?? 'lower';
    const min = Math.min(...nums.map((x) => x.v));
    const max = Math.max(...nums.map((x) => x.v));
    if (min === max) continue;
    const best = better === 'lower' ? min : max;
    const worst = better === 'lower' ? max : min;
    vals.forEach((x, i) => {
      if (!x) return;
      if (x.v === best) ranks[i][label] = 'best';
      else if (x.v === worst) ranks[i][label] = 'worst';
    });
  }
  return ranks;
}

// The address of the standalone page.

/** Ids are 16 lowercase hex chars (64 random bits). */
export const VIEW_ID_RE = /^[0-9a-f]{16}$/;

export function viewPath(id: string): string {
  return `/v/${id}`;
}

/** The view id inside a `show_view` tool result, if any. */
export function viewIdFromResult(text: string | undefined): string | undefined {
  return text?.match(/\/v\/([0-9a-f]{16})\b/)?.[1];
}
