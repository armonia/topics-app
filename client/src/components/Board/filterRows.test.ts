/**
 * The row builder of the board's one filter field.
 *
 * @covers KANBAN-69
 */
import { describe, expect, test } from 'bun:test';
import { buildFilterRows, FILTER_GROUP_ORDER, REST_CAP, type FilterOption } from './filterRows';

const OPTS: FilterOption[] = [
  { group: 'priority', value: 4, label: 'Urgente' },
  { group: 'priority', value: 3, label: 'Alta' },
  { group: 'priority', value: 2, label: 'Media' },
  { group: 'priority', value: 1, label: 'Bassa' },
  { group: 'closer', value: 'visibile' as never, label: 'visibile' },
  { group: 'closer', value: 'decisione' as never, label: 'decisione' },
  { group: 'closer', value: 'invisibile' as never, label: 'invisibile' },
  { group: 'kind', value: 'bugfix' as never, label: 'bugfix' },
  { group: 'kind', value: 'feature' as never, label: 'feature' },
  { group: 'assignee', value: 'claude', label: 'claude' },
  { group: 'assignee', value: 'codex', label: 'codex' },
  { group: 'assignee', value: 'nova', label: 'nova' },
];

describe('buildFilterRows', () => {
  test('at rest it shows the catalogue, capped, with the rest counted', () => {
    const rows = buildFilterRows(OPTS, '');
    for (const g of FILTER_GROUP_ORDER) {
      const of = rows.filter((r) => r.opt.group === g);
      expect(of.length, `${g} oltre il tetto`).toBeLessThanOrEqual(REST_CAP);
      expect(of[0]?.head, `${g} senza intestazione`).toBe(true);
    }
    // The counter must say what is hidden, or the cap becomes a silent truncation.
    const priority = rows.find((r) => r.opt.group === 'priority')!;
    expect(priority.more).toBe(OPTS.filter((o) => o.group === 'priority').length - REST_CAP);
  });

  test('a query LIFTS the cap: what you reach for cannot be behind a "+N"', () => {
    const rows = buildFilterRows(OPTS, 'a');
    const assignees = rows.filter((r) => r.opt.group === 'assignee');
    expect(assignees.length).toBeGreaterThan(REST_CAP - 1);
    expect(assignees.every((r) => r.more === 0)).toBe(true);
  });

  test('no match, NO ROWS — so the panel can simply not be mounted', () => {
    // The invariant that makes the "no results" state unreachable. A panel
    // saying "nothing found" over a board that narrowed on the same text is a
    // lie the user reads before they read the board.
    expect(buildFilterRows(OPTS, 'zzzzqqq')).toEqual([]);
  });

  test('every row on screen is there BECAUSE the query matched it', () => {
    // This is what makes consuming the text on pick correct by construction.
    const rows = buildFilterRows(OPTS, 'urg');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.opt.label.toLowerCase().includes('u'))).toBe(true);
  });

  test('the groups keep their order, and scoring never interleaves them', () => {
    const rows = buildFilterRows(OPTS, 'e');
    const seen: string[] = [];
    for (const r of rows) if (seen[seen.length - 1] !== r.opt.group) seen.push(r.opt.group);
    // A group may be absent, but none may appear twice: that is what a caption
    // repeating halfway down the list would look like.
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('an expanded group ignores the cap, and only that one', () => {
    // The `+N` is a button: without this the third closer label was reachable
    // only by typing a name you would have to already know.
    const rows = buildFilterRows(OPTS, '', REST_CAP, new Set(['closer'] as const));
    expect(rows.filter((r) => r.opt.group === 'closer').length).toBe(3);
    expect(rows.filter((r) => r.opt.group === 'priority').length).toBe(REST_CAP);
  });

  test('only the first row of a group carries the caption', () => {
    const rows = buildFilterRows(OPTS, '');
    for (const g of FILTER_GROUP_ORDER) {
      const of = rows.filter((r) => r.opt.group === g);
      expect(of.filter((r) => r.head).length, `${g}: intestazioni`).toBe(of.length ? 1 : 0);
    }
  });
});
