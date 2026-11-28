/**
 * Readable views for a raw tool result: the JSON a chat shows today as
 * coloured text (CHAT-TOOL-04) becomes a laid-out block instead. Default is
 * readable; "Original" stays the coloured JSON, a click away.
 *
 * Two tiers, same output type (`ReadableView`):
 *   1. `deterministicReadableView` — a pure shape → view mapping for the
 *      common JSON shapes a tool result takes (list of objects, plain
 *      key/value object, list of paths, an error). No model, no network.
 *   2. For a shape this misses, a cheap model picks a `DeclSpec` — a
 *      component from a closed catalog with PATHS into the source value, never
 *      values (`resolveDeclSpec` reads them back from the real JSON, so the
 *      model cannot invent a number). `validateDeclSpec` discards anything
 *      that does not resolve, so an invalid spec degrades to the generic
 *      (coloured JSON) view rather than showing something wrong.
 *
 * Everything here is pure: no fs, no network, safe on the server and in the
 * client (the cache and the model call live in `server/services/readable-view-fallback.ts`).
 */

export const MAX_TABLE_COLUMNS = 8;
export const MAX_TABLE_ROWS = 40;
export const MAX_LIST_ITEMS = 40;
export const MAX_KV_FIELDS = 24;
const MAX_CELL = 160;

export type ViewTone = 'neutral' | 'success' | 'danger' | 'warning';
/**
 * One value, typed enough for the renderer to draw it well: a status as a
 * coloured chip, an array as a row of chips, an ISO date as a readable time
 * (the client formats it: `text` keeps the raw ISO so this stays pure).
 */
export interface Cell { text: string; kind?: 'status' | 'chips' | 'date' | 'empty'; tone?: ViewTone; items?: string[] }
export interface KvField { label: string; value: Cell }
export interface KvView { kind: 'kv'; fields: KvField[] }
export interface CardView { kind: 'card'; title: string; status?: Cell; labels: string[]; fields: KvField[] }
export interface TableView { kind: 'table'; columns: string[]; rows: Cell[][] }
export interface ListItem { text: string; href?: string }
export interface ListView { kind: 'list'; items: ListItem[] }
export interface ChipView { kind: 'chip'; text: string; tone?: ViewTone }
export interface CounterView { kind: 'counter'; label: string; value: Cell }
export interface ErrorView { kind: 'error'; message: string }

export type ReadableView = KvView | CardView | TableView | ListView | ChipView | CounterView | ErrorView;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clip(text: string): string {
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const STATUS_KEY = /^(status|state|conclusion|stato)$/i;
const TONE_WORDS: Array<[RegExp, ViewTone]> = [
  [/^(done|success|succeeded|passed?|ok|merged|completed?|green|healthy|ready|open|approved)$/i, 'success'],
  [/^(fail(ed|ure)?|error|errored|cancell?ed|rejected|red|blocked|broken|down)$/i, 'danger'],
  [/^(in[ _-]?progress|pending|review|running|queued|waiting|todo|backlog|needs[ _-]input|draft)$/i, 'warning'],
];

function statusTone(v: string): ViewTone {
  for (const [re, tone] of TONE_WORDS) if (re.test(v)) return tone;
  return 'neutral';
}

/** Compact, typed value for a cell/field: never JSON braces for a scalar or an array of scalars. */
function cellOf(v: unknown, key?: string): Cell {
  if (v === null || v === undefined) return { text: '—', kind: 'empty' }; // allow-emdash: the glyph IS the rendered placeholder for a missing value
  if (typeof v === 'string') {
    if (key && STATUS_KEY.test(key) && v) return { text: v.replace(/[_-]+/g, ' '), kind: 'status', tone: statusTone(v) };
    if (ISO_DATE.test(v)) return { text: v, kind: 'date' };
    return { text: clip(v) };
  }
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v) };
  if (Array.isArray(v)) {
    if (v.length === 0) return { text: '—', kind: 'empty' }; // allow-emdash: the glyph IS the rendered placeholder for an empty list
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      const items = v.slice(0, MAX_KV_FIELDS).map((x) => clip(String(x)));
      return { text: items.join(', '), kind: 'chips', items };
    }
  }
  return { text: clip(JSON.stringify(v)) };
}

function cellText(v: unknown): string {
  return cellOf(v).text;
}

/** A string that reads like a filesystem path or a repo-relative file. */
function looksLikePath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length < 300 && (v.includes('/') || /\.[a-zA-Z0-9]{1,8}$/.test(v));
}

function errorMessage(value: Record<string, unknown>): string | null {
  const e = value.error;
  if (typeof e === 'string' && e) return e;
  if (isPlainObject(e) && typeof e.message === 'string' && e.message) return e.message;
  if (typeof value.message === 'string' && value.ok === false) return value.message;
  return null;
}

const TITLE_KEYS = ['title', 'name', 'text', 'summary'];
const LABEL_KEYS = ['labels', 'tags', 'etichette'];

/** An object with a title and a status reads as a card: headline, status chip, label chips, the rest as fields. */
function asCard(value: Record<string, unknown>, fields: KvField[]): CardView | null {
  const titleKey = TITLE_KEYS.find((k) => typeof value[k] === 'string' && value[k]);
  const statusField = fields.find((f) => f.value.kind === 'status');
  if (!titleKey || !statusField) return null;
  const labelsKey = LABEL_KEYS.find((k) => Array.isArray(value[k]));
  const labels = labelsKey ? cellOf(value[labelsKey]).items ?? [] : [];
  const rest = fields.filter((f) => f !== statusField && f.label !== titleKey && f.label !== labelsKey);
  return { kind: 'card', title: String(value[titleKey]), status: statusField.value, labels, fields: rest };
}

/** An object, or an array holding anything but scalars: a cell cannot show it without falling back to raw JSON. */
function isNested(v: unknown): boolean {
  if (isPlainObject(v)) return true;
  return Array.isArray(v) && v.some((x) => x !== null && typeof x === 'object');
}

/**
 * The shape → view mapping for what a tool result commonly is. Null means
 * "nothing deterministic fits" — the caller falls back to the model, and
 * failing that to the generic coloured view.
 */
export function deterministicReadableView(value: unknown): ReadableView | null {
  if (value === null || value === undefined) return null;

  if (isPlainObject(value)) {
    const err = errorMessage(value);
    if (err) return { kind: 'error', message: err };

    const keys = Object.keys(value);
    if (keys.length === 0) return null;
    // Nested fields have no deterministic layout: the model fallback picks one.
    if (keys.some((k) => isNested(value[k]))) return null;
    const fields: KvField[] = keys.slice(0, MAX_KV_FIELDS)
      .filter((k) => value[k] !== undefined)
      .map((k) => ({ label: k, value: cellOf(value[k], k) }));
    if (fields.length === 0) return null;
    const card = asCard(value, fields);
    if (card) return card;
    // A lone scalar field reads better as a counter than as a one-row table.
    if (fields.length === 1) return { kind: 'counter', label: fields[0].label, value: fields[0].value };
    return { kind: 'kv', fields };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every((v): v is string => typeof v === 'string')) {
      const strings: string[] = value;
      const allPaths = strings.every((v) => looksLikePath(v));
      const items: ListItem[] = strings.slice(0, MAX_LIST_ITEMS).map((text) => (allPaths ? { text } : { text: cellText(text) }));
      return { kind: 'list', items };
    }
    if (value.every(isPlainObject)) {
      if (value.some((row) => Object.values(row).some(isNested))) return null;
      const columns: string[] = [];
      for (const row of value) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
      const cappedColumns = columns.slice(0, MAX_TABLE_COLUMNS);
      const rows = value.slice(0, MAX_TABLE_ROWS).map((row) => cappedColumns.map((c) => cellOf((row as Record<string, unknown>)[c], c)));
      return { kind: 'table', columns: cappedColumns, rows };
    }
    return null;
  }

  // A bare scalar result: show it as a single counter, not as the original
  // text — but with no label the caller is better off with the generic view.
  return null;
}

// ── The model's declarative spec: a catalog entry naming PATHS, never values ──

export type DeclSpec =
  | { kind: 'kv'; fields: Array<{ label: string; path: string }> }
  | { kind: 'table'; columns: Array<{ label: string; path: string }>; rowsPath: string }
  | { kind: 'list'; itemsPath: string; textPath?: string }
  | { kind: 'chip'; path: string; tone?: 'neutral' | 'success' | 'danger' | 'warning' }
  | { kind: 'counter'; label: string; path: string }
  | { kind: 'error'; path: string };

const DECL_KINDS = new Set(['kv', 'table', 'list', 'chip', 'counter', 'error']);
const TONES = new Set(['neutral', 'success', 'danger', 'warning']);

/**
 * `foo.bar[0].baz` -> the value at that path inside `root`, or `undefined` if
 * any step misses. `[]` fans out over an array (`items[].name` -> every
 * name), the same notation `leafPaths` shows the model.
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (path === '' || path === '.') return root;
  const steps = path.replace(/\[\]/g, '.[]').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  return walk(root, steps);
}

function walk(cur: unknown, steps: string[]): unknown {
  if (steps.length === 0) return cur;
  if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
  const [step, ...rest] = steps;
  if (step === '[]') {
    if (!Array.isArray(cur)) return undefined;
    const out = cur.map((el) => walk(el, rest));
    return out.some((x) => x === undefined) ? undefined : out;
  }
  return walk(Array.isArray(cur) ? cur[Number(step)] : (cur as Record<string, unknown>)[step], rest);
}

/**
 * A column or text path is relative to its row, but a model that copies the
 * prompt's absolute notation (`data.items[].name`) names the same thing: the
 * rows path, when it prefixes the cell path, is cut off.
 */
function relativeTo(basePath: string, path: string): string {
  const base = basePath.replace(/\[\]$/, '');
  for (const prefix of [`${base}[].`, `${base}.`]) if (path.startsWith(prefix)) return path.slice(prefix.length);
  return path;
}

function isLabelPath(v: unknown): v is { label: unknown; path: unknown } {
  return isPlainObject(v) && typeof v.path === 'string' && v.path.length > 0;
}

/**
 * Structural check ONLY: every path is a non-empty string, every object has
 * no keys beyond what the kind allows (so a model cannot smuggle a literal
 * `value` field next to `path`). Does NOT check the paths resolve — that is
 * `resolveDeclSpec`'s job, against the real data.
 */
export function validateDeclSpec(raw: unknown): DeclSpec | null {
  if (!isPlainObject(raw) || typeof raw.kind !== 'string' || !DECL_KINDS.has(raw.kind)) return null;
  const kind = raw.kind as DeclSpec['kind'];
  const allowedKeys: Record<DeclSpec['kind'], string[]> = {
    kv: ['kind', 'fields'],
    table: ['kind', 'columns', 'rowsPath'],
    list: ['kind', 'itemsPath', 'textPath'],
    chip: ['kind', 'path', 'tone'],
    counter: ['kind', 'label', 'path'],
    error: ['kind', 'path'],
  };
  if (Object.keys(raw).some((k) => !allowedKeys[kind].includes(k))) return null;

  if (kind === 'kv') {
    if (!Array.isArray(raw.fields) || raw.fields.length === 0 || raw.fields.length > MAX_KV_FIELDS) return null;
    const fields = raw.fields.map((f) => (isLabelPath(f) ? { label: typeof f.label === 'string' ? f.label : (f.path as string), path: f.path as string } : null));
    if (fields.some((f) => !f)) return null;
    return { kind: 'kv', fields: fields as Array<{ label: string; path: string }> };
  }
  if (kind === 'table') {
    if (typeof raw.rowsPath !== 'string' || !raw.rowsPath) return null;
    if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.length > MAX_TABLE_COLUMNS) return null;
    const columns = raw.columns.map((c) => (isLabelPath(c) ? { label: typeof c.label === 'string' ? c.label : (c.path as string), path: c.path as string } : null));
    if (columns.some((c) => !c)) return null;
    return { kind: 'table', columns: columns as Array<{ label: string; path: string }>, rowsPath: raw.rowsPath };
  }
  if (kind === 'list') {
    if (typeof raw.itemsPath !== 'string' || !raw.itemsPath) return null;
    if (raw.textPath !== undefined && typeof raw.textPath !== 'string') return null;
    return { kind: 'list', itemsPath: raw.itemsPath, ...(raw.textPath ? { textPath: raw.textPath as string } : {}) };
  }
  if (kind === 'chip') {
    if (typeof raw.path !== 'string' || !raw.path) return null;
    if (raw.tone !== undefined && !TONES.has(raw.tone as string)) return null;
    return { kind: 'chip', path: raw.path, ...(raw.tone ? { tone: raw.tone as ChipView['tone'] } : {}) };
  }
  if (kind === 'counter') {
    if (typeof raw.label !== 'string' || !raw.label || typeof raw.path !== 'string' || !raw.path) return null;
    return { kind: 'counter', label: raw.label, path: raw.path };
  }
  // error
  if (typeof raw.path !== 'string' || !raw.path) return null;
  return { kind: 'error', path: raw.path };
}

/**
 * Reads the spec's paths back from the REAL value. Any path that misses (the
 * model named a field that is not there) discards the WHOLE spec — a view
 * with a hole in it is worse than the original JSON.
 */
export function resolveDeclSpec(spec: DeclSpec, value: unknown): ReadableView | null {
  if (spec.kind === 'kv') {
    const fields: KvField[] = [];
    for (const f of spec.fields) {
      const v = resolvePath(value, f.path);
      if (v === undefined) return null;
      fields.push({ label: f.label, value: cellOf(v, f.path.split('.').pop()) });
    }
    return { kind: 'kv', fields };
  }
  if (spec.kind === 'table') {
    const rows = resolvePath(value, spec.rowsPath);
    if (!Array.isArray(rows)) return null;
    const outRows: Cell[][] = [];
    for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
      const cells: Cell[] = [];
      for (const c of spec.columns) {
        const v = resolvePath(row, relativeTo(spec.rowsPath, c.path));
        if (v === undefined) return null;
        cells.push(cellOf(v, c.path.split('.').pop()));
      }
      outRows.push(cells);
    }
    return { kind: 'table', columns: spec.columns.map((c) => c.label), rows: outRows };
  }
  if (spec.kind === 'list') {
    const items = resolvePath(value, spec.itemsPath);
    if (!Array.isArray(items)) return null;
    const outItems: ListItem[] = [];
    for (const item of items.slice(0, MAX_LIST_ITEMS)) {
      const v = spec.textPath ? resolvePath(item, relativeTo(spec.itemsPath, spec.textPath)) : item;
      if (v === undefined) return null;
      outItems.push({ text: cellText(v) });
    }
    return { kind: 'list', items: outItems };
  }
  if (spec.kind === 'chip') {
    const v = resolvePath(value, spec.path);
    if (v === undefined) return null;
    return { kind: 'chip', text: cellText(v), ...(spec.tone ? { tone: spec.tone } : {}) };
  }
  if (spec.kind === 'counter') {
    const v = resolvePath(value, spec.path);
    if (v === undefined) return null;
    return { kind: 'counter', label: spec.label, value: cellOf(v) };
  }
  // error
  const v = resolvePath(value, spec.path);
  if (v === undefined) return null;
  return { kind: 'error', message: cellText(v) };
}

// ── Structural signature: the cache key, keys and types, never values ──

/** Caps so a pathological value cannot blow up the signature string. */
const SIG_MAX_DEPTH = 5;
const SIG_MAX_KEYS = 20;

export function shapeSignature(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  if (depth >= SIG_MAX_DEPTH) return 'any';
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${shapeSignature(value[0], depth + 1)}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort().slice(0, SIG_MAX_KEYS);
    return `{${keys.map((k) => `${k}:${shapeSignature((value as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
  }
  return typeof value;
}

/** Every leaf path + its type, for the model prompt — no values travel. */
export function leafPaths(value: unknown, prefix = '', depth = 0, out: Array<{ path: string; type: string }> = []): Array<{ path: string; type: string }> {
  if (depth >= SIG_MAX_DEPTH || out.length >= 60) return out;
  if (Array.isArray(value)) {
    if (value.length > 0) leafPaths(value[0], `${prefix}[]`, depth + 1, out);
    return out;
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value).slice(0, SIG_MAX_KEYS)) {
      leafPaths(value[k], prefix ? `${prefix}.${k}` : k, depth + 1, out);
    }
    return out;
  }
  if (prefix) out.push({ path: prefix, type: value === null ? 'null' : typeof value });
  return out;
}

/**
 * The view as it grows: cumulative prefixes of a table, list or field set, so
 * a client that reads a stream line by line can draw the first rows while the
 * rest is still on the wire. A view with no parts to grow is one chunk.
 */
export function viewChunks(view: ReadableView, size = 10): ReadableView[] {
  const prefixes = <T,>(items: T[]): T[][] => {
    const out: T[][] = [];
    for (let n = size; n < items.length; n += size) out.push(items.slice(0, n));
    out.push(items);
    return out;
  };
  if (view.kind === 'table') return prefixes(view.rows).map((rows) => ({ ...view, rows }));
  if (view.kind === 'list') return prefixes(view.items).map((items) => ({ ...view, items }));
  if (view.kind === 'kv') return prefixes(view.fields).map((fields) => ({ ...view, fields }));
  return [view];
}
