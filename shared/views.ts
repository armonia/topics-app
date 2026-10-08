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
import { imageSrc, linkOf, priceOf, str, strList, MAX_TITLE } from './views-util';
import { normalizeTable, tableViewSchema } from './views-table';
import { normalizeTimeline, timelineViewSchema } from './views-timeline';

/** The views the catalogue knows; the union grows a member per view. */
export const VIEW_KINDS = ['compare', 'table', 'timeline'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

// Limits. Not cosmetic: they keep the view readable and the payload small (the
// detail travels in every WS frame and in every history row).
export const COMPARE_MIN_OPTIONS = 2;
export const COMPARE_MAX_OPTIONS = 4;
const MAX_IMAGES = 12;
const MAX_METRICS = 8;

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
export const viewSpecSchema = z.discriminatedUnion('view', [compareViewSchema, tableViewSchema, timelineViewSchema]);

export type ViewMetric = z.infer<typeof metricSchema>;
export type CompareOption = z.infer<typeof compareOptionSchema>;
export type CompareViewSpec = z.infer<typeof compareViewSchema>;
export type ViewSpec = z.infer<typeof viewSpecSchema>;

export type NormalizeResult = { ok: true; spec: ViewSpec } | { ok: false; errors: string[] };

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
    const optionTitle = str(r.title, MAX_TITLE);
    if (!optionTitle) { errors.push(`options[${i}].title (string) is required`); return; }
    const opt: CompareOption = { title: optionTitle };
    const subtitle = str(r.subtitle);
    if (subtitle) opt.subtitle = subtitle;
    // A price comes in three shapes: number, text ("184 EUR"), object.
    const price = priceOf(
      typeof r.price === 'number' && typeof r.currency === 'string' ? { amount: r.price, currency: r.currency } : r.price,
      r.price_note ?? r.priceNote,
    );
    if (price) opt.price = price;
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
    const link = linkOf(r.link ?? r.url);
    if (link) opt.link = link;
    if (r.recommended === true) opt.recommended = true;
    options.push(opt);
  });
  // One recommendation at most: a second one recommends nothing.
  const recommended = options.filter((o) => o.recommended);
  if (recommended.length > 1) errors.push(`at most one option may be 'recommended' (got ${recommended.length})`);
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
  const spec =
    kind === 'compare' ? normalizeCompare(raw, errors)
    : kind === 'table' ? normalizeTable(raw, errors)
    : kind === 'timeline' ? normalizeTimeline(raw, errors)
    : null;
  if (!spec && !errors.length) errors.push(`unknown view '${String(kind)}' (known: ${VIEW_KINDS.join(', ')})`);
  return spec ? { ok: true, spec } : { ok: false, errors };
}

/** Parse an already-normalized spec (from a stored row or a WS frame). */
export function parseViewSpec(value: unknown): ViewSpec | null {
  const r = viewSpecSchema.safeParse(value);
  return r.success ? (r.data as ViewSpec) : null;
}

// Metrics: who wins.

/** Metric labels in order of first appearance across options: the shared row order. */
export function metricLabelsInOrder(options: readonly CompareOption[]): string[] {
  const seen: string[] = [];
  for (const o of options) for (const m of o.metrics ?? []) if (!seen.includes(m.label)) seen.push(m.label);
  return seen;
}

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

/** "compare · 3 options": what the tool answer and the chat header say about a view. */
export function viewSummary(spec: ViewSpec): { kind: ViewKind; count: number; unit: 'options' | 'rows' | 'steps' } {
  if (spec.view === 'compare') return { kind: 'compare', count: spec.options.length, unit: 'options' };
  if (spec.view === 'table') return { kind: 'table', count: spec.rows.length, unit: 'rows' };
  return { kind: 'timeline', count: spec.steps.length, unit: 'steps' };
}

/** The view id inside a `show_view` tool result, if any. */
export function viewIdFromResult(text: string | undefined): string | undefined {
  return text?.match(/\/v\/([0-9a-f]{16})\b/)?.[1];
}
