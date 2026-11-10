import type { LucideIcon } from 'lucide-react';

/**
 * The view models of the filter bar. The bar knows nothing of the list it
 * filters: it draws these and reports what the person did. The engine that
 * builds them from real items is `ui-gallery/app/filters.ts`.
 */

/** What a field holds: a closed set of values, free text, or a date. */
export type FilterKind = 'choice' | 'text' | 'date';

/** The conditions a token can have; `within` counts days from today. */
export type FilterOp = 'is' | 'not' | 'contains' | 'before' | 'after' | 'within';

/** The conditions a field of each kind offers, unless it names its own. */
export const DEFAULT_OPS: Record<FilterKind, FilterOp[]> = {
  choice: ['is', 'not'],
  text: ['contains', 'is', 'not'],
  date: ['before', 'after', 'within'],
};

/** A field the list can be filtered by. */
export interface FilterFieldModel {
  id: string;
  label: string;
  icon: LucideIcon;
  kind: FilterKind;
  ops: FilterOp[];
}

/** One value to pick for a field, with how many items carry it. */
export interface FilterValueModel {
  value: string;
  label: string;
  icon?: LucideIcon;
  count?: number;
}

/** What a token holds before it is a token: the three things the person picks. */
export interface FilterDraft {
  field: string;
  op: FilterOp;
  value: string;
}

/** A filter on show: a field, a condition and a value, with their words. */
export interface FilterTokenModel extends FilterDraft {
  id: string;
  fieldLabel: string;
  icon: LucideIcon;
  kind: FilterKind;
  opLabel: string;
  valueLabel: string;
  valueIcon?: LucideIcon;
  /** The conditions the field offers, for the picker that changes it. */
  ops: FilterOp[];
}

/** A suggestion for what is being typed, listed under the name of its group. */
export interface FilterSuggestion {
  id: string;
  /** The heading of the group (the name of the field it comes from). */
  group: string;
  icon: LucideIcon;
  label: string;
  /** Quiet text on the right, e.g. how many items match. */
  detail?: string;
  /** Picking it adds this filter. */
  draft: FilterDraft;
}

/** A named set of tokens, as a pill with the number of items it shows. */
export interface SavedFilterModel {
  id: string;
  name: string;
  count: number;
  active: boolean;
  /** Made by the person (can be deleted), not shipped with the screen. */
  removable?: boolean;
}

/** Everything the bar needs about the list, and what it reports back. */
export interface FilterBarModel {
  query: string;
  /** What the field filters, in its own words (`Filtra le card`); the bar's generic one when absent. */
  placeholder?: string;
  onQuery: (query: string) => void;
  /** Suggestions for the current `query`, already grouped in order. */
  suggestions: FilterSuggestion[];
  onPickSuggestion: (s: FilterSuggestion) => void;
  fields: FilterFieldModel[];
  /** The values to pick for a field (computed from the items, with counts). */
  valuesOf: (field: string) => FilterValueModel[];
  tokens: FilterTokenModel[];
  onAddToken: (draft: FilterDraft) => void;
  onChangeToken: (id: string, draft: FilterDraft) => void;
  onRemoveToken: (id: string) => void;
  saved: SavedFilterModel[];
  onApplySaved: (id: string) => void;
  onRemoveSaved?: (id: string) => void;
  /** Present: a bar with tokens offers to save them under a name. */
  onSave?: (name: string) => void;
  onClear: () => void;
  /** How many items show, and how many there are. */
  shown?: number;
  total?: number;
}

/** Text without accents and case, the way a person types it: what searches compare. */
export function plain(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
