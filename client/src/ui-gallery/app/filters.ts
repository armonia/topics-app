/**
 * The state of a filtered list, the same shape for every list of the preview
 * (Da fare, Contratti, Dati, Flussi, Conoscenza, Programmi, Squadra): what is (allow-italian: quotes the Italian interface)
 * typed in the search, the filters as tokens and the saved filter on show.
 * Kept with `ctx.ui(<list key>, EMPTY_FILTERS)`, so it survives navigation and
 * a reload; a redirect may set it (`kit.ts` RedirectDef.ui).
 *
 * Below the state is the engine that turns a list into a filtered list: the
 * fields are described once per list, their values come from the items, and
 * `useListFilters` reads and writes the state and hands back the elements to
 * show and the props of `FilterBar`. A token filters like this: tokens on
 * different fields all have to hold; several `is` tokens on one field are
 * alternatives (any of them); every other condition on the same field has to
 * hold as well.
 */
import { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { UiCopy } from '../../ui/copy/types';
import {
  DEFAULT_OPS, plain, type FilterBarModel, type FilterDraft, type FilterFieldModel, type FilterKind, type FilterOp,
  type FilterSuggestion, type FilterTokenModel, type FilterValueModel, type SavedFilterModel,
} from '../../ui/filters/model';
import type { ScreenCtx } from './kit';

/** One filter: a field, a condition and a value, as ids (`flusso`, `is`, `orbit-fir`). (allow-italian: quotes a field id) */
export interface FilterToken {
  id: string;
  field: string;
  op: string;
  value: string;
}

export interface ListFilterState {
  query: string;
  tokens: FilterToken[];
  /** The id of the saved filter whose tokens are on show, until one is changed. */
  saved?: string;
}

export const EMPTY_FILTERS: ListFilterState = { query: '', tokens: [] };

/* ---------- the engine ---------- */

/** One field of a list, described once. `get` reads it from an item. */
export interface FilterField<T> {
  id: string;
  label: string;
  icon: LucideIcon;
  kind: FilterKind;
  /** The conditions on offer; by default those of its kind (`DEFAULT_OPS`). */
  ops?: FilterOp[];
  /**
   * What the item holds for this field: the id of a value for a choice (an
   * item may carry several), the text for a text, an ISO date for a date.
   */
  get: (item: T) => string | readonly string[] | null | undefined;
  /** The words for a value of a choice (default: the value itself). */
  valueLabel?: (value: string) => string;
  valueIcon?: (value: string) => LucideIcon | undefined;
  /** The order of the values of a choice; the rest follow alphabetically. */
  order?: readonly string[];
  /** Values to list even when no item carries them (they show a count of 0). */
  values?: readonly string[];
  /**
   * Whether typing in the search suggests this field's values. On for a
   * choice unless `false`; off for a text unless `true`; never for a date.
   */
  suggest?: boolean;
}

/** The fields of one list, and the text the search looks in. */
export interface FilterSchema<T> {
  fields: ReadonlyArray<FilterField<T>>;
  /** Everything a person may type to find an item (id, title, people...). */
  text: (item: T) => string;
}

/** A filter that comes with a screen, or that a person saved: a name and its tokens. */
export interface SavedFilter {
  id: string;
  name: string;
  tokens: FilterToken[];
  query?: string;
}

/** The most suggestions under one heading, and in all. */
const SUGGESTS_PER_GROUP = 4;
const SUGGESTS_TOTAL = 12;

function valuesOfItem<T>(field: FilterField<T>, item: T): string[] {
  const raw = field.get(item);
  if (raw === null || raw === undefined) return [];
  return (typeof raw === 'string' ? [raw] : [...raw]).filter((v) => v !== '');
}

/** Days from `from` to `to`, both `YYYY-MM-DD` (negative when `to` is earlier). */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

function matches<T>(field: FilterField<T>, token: FilterToken, item: T, today: string): boolean {
  const have = valuesOfItem(field, item);
  const want = token.value;
  const same = (v: string) => (field.kind === 'text' ? plain(v) === plain(want) : field.kind === 'date' ? v.slice(0, 10) === want : v === want);
  switch (token.op) {
    case 'is': return have.some(same);
    case 'not': return !have.some(same);
    case 'contains': return have.some((v) => plain(v).includes(plain(want)));
    case 'before': return have[0] !== undefined && have[0].slice(0, 10) < want;
    case 'after': return have[0] !== undefined && have[0].slice(0, 10) > want;
    case 'within': {
      if (have[0] === undefined) return false;
      const diff = daysBetween(today, have[0].slice(0, 10));
      return diff >= 0 && diff <= Number(want);
    }
    default: return true;
  }
}

/**
 * The items that pass the search text and every token. `now` is the ISO
 * date-time the demo runs at: `within` counts days from its date, today
 * included. A token on a field the list does not have is ignored.
 */
export function applyFilters<T>(items: readonly T[], schema: FilterSchema<T>, state: Pick<ListFilterState, 'query' | 'tokens'>, now: string): T[] {
  const today = now.slice(0, 10);
  const words = plain(state.query).split(/\s+/).filter(Boolean);
  const byField = new Map<string, FilterToken[]>();
  for (const t of state.tokens) {
    if (!schema.fields.some((f) => f.id === t.field)) continue;
    byField.set(t.field, [...(byField.get(t.field) ?? []), t]);
  }
  return items.filter((item) => {
    if (words.length) {
      const text = plain(schema.text(item));
      if (!words.every((w) => text.includes(w))) return false;
    }
    for (const [id, tokens] of byField) {
      const field = schema.fields.find((f) => f.id === id);
      if (!field) continue;
      const any = tokens.filter((t) => t.op === 'is');
      if (any.length && !any.some((t) => matches(field, t, item, today))) return false;
      if (!tokens.filter((t) => t.op !== 'is').every((t) => matches(field, t, item, today))) return false;
    }
    return true;
  });
}

/** The values of a field as found in the items, with how many items carry each. */
export function fieldValues<T>(items: readonly T[], field: FilterField<T>): FilterValueModel[] {
  const counts = new Map<string, number>();
  for (const v of field.values ?? []) counts.set(v, 0);
  for (const item of items) for (const v of new Set(valuesOfItem(field, item))) counts.set(v, (counts.get(v) ?? 0) + 1);
  const order = field.order ?? [];
  const rank = (v: string) => {
    const i = order.indexOf(v);
    return i < 0 ? order.length : i;
  };
  const label = (v: string) => (field.kind === 'text' ? v : field.valueLabel?.(v) ?? v);
  return [...counts]
    .map(([value, count]): FilterValueModel => ({ value, label: label(value), icon: field.valueIcon?.(value), count }))
    .sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label));
}

/**
 * What typing `query` suggests: the values of the fields that take part
 * (choices, and texts that ask for it) whose words contain what was typed,
 * those that begin with it first, under the name of their field. Picking one
 * adds the filter `field is value`.
 */
export function suggestionsFor<T>(items: readonly T[], schema: FilterSchema<T>, query: string): FilterSuggestion[] {
  const needle = plain(query.trim());
  if (!needle) return [];
  const out: FilterSuggestion[] = [];
  for (const field of schema.fields) {
    const on = field.kind === 'choice' ? field.suggest !== false : field.kind === 'text' && field.suggest === true;
    if (!on || !(field.ops ?? DEFAULT_OPS[field.kind]).includes('is')) continue;
    const found = fieldValues(items, field)
      .filter((v) => plain(v.label).includes(needle))
      .sort((a, b) => Number(!plain(a.label).startsWith(needle)) - Number(!plain(b.label).startsWith(needle)))
      .slice(0, SUGGESTS_PER_GROUP);
    for (const v of found) {
      out.push({
        id: `${field.id}:${v.value}`,
        group: field.label,
        icon: v.icon ?? field.icon,
        label: v.label,
        detail: v.count ? String(v.count) : undefined,
        draft: { field: field.id, op: 'is', value: v.value },
      });
    }
  }
  return out.slice(0, SUGGESTS_TOTAL);
}

/** `2026-11-08` as `08/11/2026`, the way a date reads on a token. */
function dateWords(iso: string): string {
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

function fieldModel<T>(f: FilterField<T>): FilterFieldModel {
  return { id: f.id, label: f.label, icon: f.icon, kind: f.kind, ops: f.ops ?? DEFAULT_OPS[f.kind] };
}

function tokenModel<T>(t: FilterToken, f: FilterField<T>, copy: UiCopy): FilterTokenModel {
  const op = t.op as FilterOp;
  const valueLabel = op === 'within' ? copy.filters.days(Number(t.value))
    : f.kind === 'date' ? dateWords(t.value)
      : f.kind === 'choice' ? f.valueLabel?.(t.value) ?? t.value
        : t.value;
  return {
    id: t.id, field: f.id, op, value: t.value,
    fieldLabel: f.label, icon: f.icon, kind: f.kind, opLabel: copy.filters.ops[op], valueLabel,
    valueIcon: f.kind === 'choice' ? f.valueIcon?.(t.value) : undefined,
    ops: f.ops ?? DEFAULT_OPS[f.kind],
  };
}

/** The next free id for a token: `t1`, `t2`... (an id stays with its token when it is edited). */
function nextTokenId(tokens: readonly FilterToken[]): string {
  const top = tokens.reduce((n, t) => Math.max(n, Number(/^t(\d+)$/.exec(t.id)?.[1] ?? 0)), 0);
  return `t${top + 1}`;
}

const sameFilter = (a: Pick<FilterToken, 'field' | 'op' | 'value'>, b: Pick<FilterToken, 'field' | 'op' | 'value'>) => a.field === b.field && a.op === b.op && a.value === b.value;

/** What `useListFilters` hands back: the items to show and the props of `FilterBar`. */
export interface ListFilters<T> {
  /** The items that pass the search and the tokens. */
  items: T[];
  state: ListFilterState;
  /** `<FilterBar copy={copy} {...bar} trailing={...} />` */
  bar: FilterBarModel;
}

/**
 * Reads and writes the filter state of a list under `key` (`ctx.ui(key,
 * EMPTY_FILTERS)`, so it survives navigation and a reload and a redirect may
 * set it), and builds the props of the bar. The filters a person saves are
 * kept next to it under `${key}.saved`; `presets` are the ones the screen
 * ships with (they cannot be deleted). Changing the text or a token puts the
 * saved filter that was on show away. Keep `schema` and `presets` stable
 * between renders (module level, or memoised): the filtered list is memoised
 * on them.
 */
export function useListFilters<T>(
  ctx: Pick<ScreenCtx, 'ui' | 'copy' | 'now'>,
  { key, items, schema, presets = [] }: { key: string; items: readonly T[]; schema: FilterSchema<T>; presets?: SavedFilter[] },
): ListFilters<T> {
  const [state, setState] = ctx.ui<ListFilterState>(key, EMPTY_FILTERS);
  const [mine, setMine] = ctx.ui<SavedFilter[]>(`${key}.saved`, []);
  const { copy, now } = ctx;

  const shown = useMemo(() => applyFilters(items, schema, state, now), [items, schema, state, now]);
  const fields = useMemo(() => schema.fields.map(fieldModel), [schema]);
  const tokens = useMemo(
    () => state.tokens.flatMap((t) => {
      const f = schema.fields.find((x) => x.id === t.field);
      return f ? [tokenModel(t, f, copy)] : [];
    }),
    [state.tokens, schema, copy],
  );
  const savedAll = [...presets, ...mine];
  const saved: SavedFilterModel[] = savedAll.map((f) => ({
    id: f.id,
    name: f.name,
    count: applyFilters(items, schema, { query: f.query ?? '', tokens: f.tokens }, now).length,
    active: state.saved === f.id,
    removable: mine.some((m) => m.id === f.id),
  }));

  const edit = (fn: (prev: ListFilterState) => ListFilterState) => setState((prev) => ({ ...fn(prev), saved: undefined }));
  const add = (prev: ListFilterState, draft: FilterDraft): FilterToken[] =>
    prev.tokens.some((t) => sameFilter(t, draft)) ? prev.tokens : [...prev.tokens, { id: nextTokenId(prev.tokens), ...draft }];

  const bar: FilterBarModel = {
    query: state.query,
    onQuery: (query) => edit((prev) => ({ ...prev, query })),
    suggestions: suggestionsFor(items, schema, state.query),
    onPickSuggestion: (s) => edit((prev) => ({ query: '', tokens: add(prev, s.draft) })),
    fields,
    valuesOf: (id) => {
      const f = schema.fields.find((x) => x.id === id);
      return f && f.kind === 'choice' ? fieldValues(items, f) : [];
    },
    tokens,
    onAddToken: (draft) => edit((prev) => ({ ...prev, tokens: add(prev, draft) })),
    onChangeToken: (id, draft) => edit((prev) => ({
      ...prev,
      tokens: prev.tokens.flatMap((t) => {
        if (t.id !== id) return [t];
        // Edited into a filter that is already there: keep the other one only.
        return prev.tokens.some((o) => o.id !== id && sameFilter(o, draft)) ? [] : [{ id, ...draft }];
      }),
    })),
    onRemoveToken: (id) => edit((prev) => ({ ...prev, tokens: prev.tokens.filter((t) => t.id !== id) })),
    saved,
    onApplySaved: (id) => {
      const f = savedAll.find((x) => x.id === id);
      if (!f) return;
      // Pressing the filter that is on show takes it off.
      setState(state.saved === id ? EMPTY_FILTERS : { query: f.query ?? '', tokens: f.tokens, saved: id });
    },
    onRemoveSaved: (id) => {
      setMine((prev) => prev.filter((f) => f.id !== id));
      if (state.saved === id) setState(EMPTY_FILTERS);
    },
    onSave: (name) => {
      const id = `mine-${mine.reduce((n, f) => Math.max(n, Number(/^mine-(\d+)$/.exec(f.id)?.[1] ?? 0)), 0) + 1}`;
      setMine((prev) => [...prev, { id, name, tokens: state.tokens, query: state.query || undefined }]);
      setState((prev) => ({ ...prev, saved: id }));
    },
    onClear: () => setState(EMPTY_FILTERS),
    shown: shown.length,
    total: items.length,
  };
  return { items: shown, state, bar };
}
