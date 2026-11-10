/**
 * The search of the top bar and of Cmd+K: every area says what it can find
 * (`AreaModule.search`), and a query matches when every word of it appears in
 * the title, the number, the line under it, the extra words or the facts of
 * an entry, accents and case ignored. Ranking: a title (or number) that
 * starts with the word, then one with a word that starts with it, then one
 * that holds it, then the line under it, then the extra words.
 */
import type { SearchKind } from '../../ui/copy/app';
import type { SearchEntry } from './kit';

/** The kinds of result in the order the palette and the results page list them. */
export const SEARCH_KINDS: readonly SearchKind[] = ['card', 'flussi', 'documenti', 'dati', 'persone', 'programmi', 'impostazioni']; // allow-italian: identifiers compared by value, not shown

export const isSearchKind = (id: string | undefined): id is SearchKind => Boolean(id) && (SEARCH_KINDS as readonly string[]).includes(id as string);

/** Text without accents and case, the way a person types it. */
export const foldText = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The words of a query, folded. */
export const queryWords = (query: string): string[] => foldText(query).split(/\s+/).filter(Boolean);

/** Whether `word` starts the text or any word of it (after a space, a dash, a slash, a dot). */
function startsAWord(text: string, word: string): boolean {
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (i === 0 || !/[a-z0-9]/.test(text[i - 1])) return true;
  }
  return false;
}

/** The longest line of context shown for a fact that matched, ellipses included. */
const EXCERPT_MAX = 64;

/**
 * A short stretch of `text` around the first place `word` (folded) appears: it
 * starts and ends on a space, never inside a word, and always holds the whole
 * word, so the `<mark>` is in the part that stays visible after the line is
 * cut. A text that already fits comes back as it is.
 */
export function excerptAround(text: string, word: string): string {
  if (text.length <= EXCERPT_MAX) return text;
  /* Fold one character at a time (as `Marked` does) so the index maps back to `text`. */
  let folded = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const f = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    folded += f;
    for (let k = 0; k < f.length; k += 1) at.push(i);
  }
  const hit = folded.indexOf(word);
  if (hit < 0 || word.length >= EXCERPT_MAX - 8) return text.slice(0, EXCERPT_MAX);
  const from = at[hit];
  const to = at[hit + word.length - 1] + 1;
  const room = EXCERPT_MAX - (to - from) - 2;
  let start = Math.max(0, from - Math.floor(room * 0.4));
  let end = Math.min(text.length, to + (room - (from - start)));
  start = Math.max(0, Math.min(start, end - (EXCERPT_MAX - 2)));
  if (start > 0) {
    const space = text.indexOf(' ', start);
    start = space >= 0 && space < from ? space + 1 : from;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    end = space > to ? space : to;
  }
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export interface SearchHit {
  entry: SearchEntry;
  score: number;
  /** The fact that matched when the words are neither in the title nor in the line under it. */
  via?: string;
}

/** The entries that match `query`, best first (equal scores keep the order the areas gave them). */
export function searchHits(entries: readonly SearchEntry[], query: string): SearchHit[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const title = foldText(entry.title);
    const ref = foldText(entry.ref ?? '');
    const head = `${ref} ${title}`;
    const detail = foldText(entry.detail ?? '');
    const keywords = foldText(entry.keywords ?? '');
    const facets = (entry.facets ?? []).map((f) => ({ text: f, folded: foldText(f) }));
    let score = 0;
    let via: string | undefined;
    let matched = true;
    for (const w of words) {
      if (title.startsWith(w) || (ref !== '' && ref.startsWith(w))) score += 6;
      else if (startsAWord(head, w)) score += 5;
      else if (head.includes(w)) score += 4;
      else if (detail.includes(w)) score += 3;
      else {
        const fact = facets.find((f) => f.folded.includes(w));
        if (fact) {
          via ??= excerptAround(fact.text, w);
          score += 2;
        } else if (keywords.includes(w)) score += 1;
        else {
          matched = false;
          break;
        }
      }
    }
    if (matched) hits.push({ entry, score, via });
  }
  return hits.sort((a, b) => b.score - a.score);
}

export interface HitGroup {
  /** A known kind, or `group:<label>` for an entry that names only its group. */
  id: string;
  label?: string;
  hits: SearchHit[];
}

/** Hits grouped by kind: the known kinds first in their order, then the groups that only name themselves, in the order they first appear. */
export function groupHits(hits: readonly SearchHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const hit of hits) {
    const id = hit.entry.kind ?? `group:${hit.entry.group}`;
    const g = groups.get(id) ?? { id, label: hit.entry.kind ? undefined : hit.entry.group, hits: [] };
    g.hits.push(hit);
    groups.set(id, g);
  }
  const rank = (id: string) => {
    const at = SEARCH_KINDS.indexOf(id as SearchKind);
    return at < 0 ? SEARCH_KINDS.length : at;
  };
  return [...groups.values()].sort((a, b) => rank(a.id) - rank(b.id));
}
