/**
 * filterRows — the row list of the board's ONE filter field.
 *
 * Pure on purpose: it is where the two invariants that keep the panel honest
 * live, and both are cheap to falsify without a DOM.
 *
 *   NO MATCH, NO ROWS. The caller simply does not mount the panel, so the "no
 *   results" state is unreachable. A panel saying "no results" over a board
 *   that DID narrow on the same text is a lie the user reads before the board.
 *
 *   ROWS ARE ALWAYS FILTERED BY THE QUERY, so a row can only be on screen
 *   BECAUSE the query produced it. That is what makes consuming the query when
 *   a row is picked correct by construction, instead of a guess about intent.
 */
import { fuzzyScore } from '../../lib/fuzzyScore';
import type { TaskLabel } from '../../lib/board';

export type FilterGroup = 'priority' | 'closer' | 'kind' | 'assignee';

export type FilterOption =
  | { group: 'priority'; value: number; label: string; title?: string }
  | { group: 'closer'; value: TaskLabel; label: string; title?: string }
  | { group: 'kind'; value: TaskLabel; label: string; title?: string }
  | { group: 'assignee'; value: string; label: string; title?: string };

export interface FilterRow {
  opt: FilterOption;
  /** True on the first row of a group: the caption is drawn above it. */
  head: boolean;
  /** How many options of this group the rest cap is hiding (0 when none). */
  more: number;
}

export const FILTER_GROUP_ORDER: readonly FilterGroup[] = ['priority', 'closer', 'kind', 'assignee'];

/**
 * AT REST each group shows its first two, and the caption carries `+N`.
 *
 * Without a cap the catalogue opens on five priorities plus every agent on the
 * board, and the labels — the group that LOST its own chip on the row — are
 * born below the fold, which is the opposite of the reason they were merged in.
 * A query is a REACH for one specific thing, so it lifts the cap: what you are
 * typing towards can never be the thing hidden behind `+N`.
 */
export const REST_CAP = 2;

export function buildFilterRows(
  options: readonly FilterOption[],
  text: string,
  cap = REST_CAP,
  /**
   * Groups whose cap the user has lifted by hand.
   *
   * Without this the `+N` is a truncation that ANNOUNCES itself and offers no
   * way through: the third closer label could be reached only by typing a name
   * you would have to already know. Measured the hard way - `board-labels`
   * went red on exactly that row.
   */
  expanded?: ReadonlySet<FilterGroup>,
): FilterRow[] {
  const q = text.trim();
  const out: FilterRow[] = [];
  for (const g of FILTER_GROUP_ORDER) {
    const inGroup = options.filter((o) => o.group === g);
    // Scored WITHIN the group, never across it: one global sort interleaves the
    // groups and the captions start repeating halfway down the list.
    const matched = q
      ? inGroup
          .map((o) => ({ o, s: fuzzyScore(q, o.label) }))
          .filter((r) => r.s.match)
          .sort((a, b) => b.s.score - a.s.score)
          .map((r) => r.o)
      : inGroup;
    const shown = q || expanded?.has(g) ? matched : matched.slice(0, cap);
    shown.forEach((o, i) =>
      out.push({ opt: o, head: i === 0, more: i === 0 ? matched.length - shown.length : 0 }),
    );
  }
  return out;
}
