/**
 * The groups of the search palette, built from the entries the areas hand in:
 * with a query, the results grouped by kind (at most a few per kind, then a
 * row «Altri N» that opens the page of that kind); with the field empty, the allow-italian: quotes the words on screen
 * places visited last and a few useful entries. Pure: the container hands in
 * what it knows and keeps the state.
 */
import type { LucideIcon } from 'lucide-react';
import { NAV_ICON } from '../../ui/icons';
import type { SearchKind } from '../../ui/copy/app';
import type { UiCopy } from '../../ui/copy/types';
import type { PaletteGroupModel, PaletteItemModel } from '../../ui/shell/CommandPalette';
import type { SearchEntry } from './kit';
import { SEARCH_KINDS, groupHits, queryWords, searchHits, type SearchHit } from './search';
import { P } from './paths';

/** One icon per kind of result, the same in the palette and on the results page. */
export const SEARCH_KIND_ICON: Record<SearchKind, LucideIcon> = {
  card: NAV_ICON.inbox,
  flussi: NAV_ICON.flows,
  documenti: NAV_ICON.knowledge,
  dati: NAV_ICON.data,
  persone: NAV_ICON.team,
  programmi: NAV_ICON.programs,
  impostazioni: NAV_ICON.settings,
};

/** How many results of a kind the palette shows before «Altri N». allow-italian: quotes the words on screen */
export const PALETTE_PER_GROUP = 5;

const isKind = (id: string): id is SearchKind => (SEARCH_KINDS as readonly string[]).includes(id);

/** The address of the results page of a query, for every kind or for one. */
export function resultsPath(query: string, kind?: SearchKind | string): string {
  const base = P.search(query.trim());
  return kind && isKind(kind) ? `${base}/${encodeURIComponent(kind)}` : base;
}

/** A place visited lately, as the container knows it. */
export interface PaletteRecent {
  path: string;
  title: string;
  detail?: string;
  icon: LucideIcon;
}

export interface PaletteBuild {
  groups: PaletteGroupModel[];
  /** The address an item opens, by its id. */
  pathOf: (id: string) => string | undefined;
  /** The words to set in `<mark>`. */
  words: string[];
  /** How many results the query has in all; 0 with the field empty. */
  total: number;
  /** The query found nothing (so the groups, if any, are only suggestions). */
  none: boolean;
}

export function buildPalette({ query, entries, suggestions, recents, copy }: {
  query: string;
  entries: readonly SearchEntry[];
  /** Called only when the list shows them: the field is empty or nothing matched. */
  suggestions: () => readonly SearchEntry[];
  recents: readonly PaletteRecent[];
  copy: UiCopy;
}): PaletteBuild {
  const s = copy.app.search;
  const paths = new Map<string, string>();
  const item = (id: string, path: string, model: Omit<PaletteItemModel, 'id'>): PaletteItemModel => {
    paths.set(id, path);
    return { id, ...model };
  };
  const words = queryWords(query);
  const suggested = (): PaletteGroupModel[] => {
    const list = suggestions();
    if (!list.length) return [];
    return [{ id: 'suggeriti', label: s.suggested, items: list.map((e, i) => item(`suggested|${i}`, e.path, { title: e.title, detail: e.detail, icon: e.icon })) }];
  };

  if (!words.length) {
    const groups: PaletteGroupModel[] = [];
    if (recents.length) {
      groups.push({ id: 'recenti', label: s.recent, items: recents.map((r, i) => item(`recent|${i}`, r.path, { title: r.title, detail: r.detail, icon: r.icon })) }); // allow-italian: "recenti" is a group id, not shown
    }
    groups.push(...suggested());
    return { groups, pathOf: (id) => paths.get(id), words, total: 0, none: false };
  }

  const hits = searchHits(entries, query);
  if (!hits.length) {
    return { groups: suggested(), pathOf: (id) => paths.get(id), words, total: 0, none: true };
  }
  const groups = groupHits(hits).map((g): PaletteGroupModel => {
    const kind = isKind(g.id) ? g.id : undefined;
    const shown = g.hits.slice(0, PALETTE_PER_GROUP);
    const items = shown.map((h: SearchHit, i) => item(`${g.id}|${i}`, h.entry.path, { title: h.entry.title, detail: h.entry.detail, via: h.via, icon: h.entry.icon }));
    const rest = g.hits.length - shown.length;
    if (rest > 0) items.push(item(`more|${g.id}`, resultsPath(query, kind), { title: s.more(rest), icon: kind ? SEARCH_KIND_ICON[kind] : NAV_ICON.overview, more: true }));
    return { id: g.id, label: kind ? s.groups[kind] : g.label ?? g.id, icon: kind ? SEARCH_KIND_ICON[kind] : undefined, total: g.hits.length, items };
  });
  return { groups, pathOf: (id) => paths.get(id), words, total: hits.length, none: false };
}
