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

export interface KvField { label: string; value: string }
export interface KvView { kind: 'kv'; fields: KvField[] }
export interface TableView { kind: 'table'; columns: string[]; rows: string[][] }
export interface ListItem { text: string; href?: string }
export interface ListView { kind: 'list'; items: ListItem[] }
export interface ChipView { kind: 'chip'; text: string; tone?: 'neutral' | 'success' | 'danger' | 'warning' }
export interface CounterView { kind: 'counter'; label: string; value: string }
export interface ErrorView { kind: 'error'; message: string }

export type ReadableView = KvView | TableView | ListView | ChipView | CounterView | ErrorView;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Compact, one-line text for a cell/field value — never JSON braces for a scalar. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '—'; // allow-emdash: the glyph IS the rendered placeholder for a missing value
  if (typeof v === 'string') return v.length > MAX_CELL ? `${v.slice(0, MAX_CELL - 1)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const text = JSON.stringify(v);
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
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
    const fields: KvField[] = keys.slice(0, MAX_KV_FIELDS)
      .filter((k) => value[k] !== undefined)
      .map((k) => ({ label: k, value: cellText(value[k]) }));
    if (fields.length === 0) return null;
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
      const columns: string[] = [];
      for (const row of value) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
      const cappedColumns = columns.slice(0, MAX_TABLE_COLUMNS);
      const rows = value.slice(0, MAX_TABLE_ROWS).map((row) => cappedColumns.map((c) => cellText((row as Record<string, unknown>)[c])));
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

/** `foo.bar[0].baz` -> the value at that path inside `root`, or `undefined` if any step misses. */
export function resolvePath(root: unknown, path: string): unknown {
  if (path === '' || path === '.') return root;
  const steps = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = root;
  for (const step of steps) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(step)] : (cur as Record<string, unknown>)[step];
  }
  return cur;
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
      fields.push({ label: f.label, value: cellText(v) });
    }
    return { kind: 'kv', fields };
  }
  if (spec.kind === 'table') {
    const rows = resolvePath(value, spec.rowsPath);
    if (!Array.isArray(rows)) return null;
    const outRows: string[][] = [];
    for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
      const cells: string[] = [];
      for (const c of spec.columns) {
        const v = resolvePath(row, c.path);
        if (v === undefined) return null;
        cells.push(cellText(v));
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
      const v = spec.textPath ? resolvePath(item, spec.textPath) : item;
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
    return { kind: 'counter', label: spec.label, value: cellText(v) };
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
