/**
 * Pure reducer tests for the task-scoped browser layout. No I/O — the ui-state
 * persistence + React hook are exercised only in the app. Deterministic group
 * ids are injected via `genId` so split/reconcile output is stable.
 */
import { describe, test, expect } from 'bun:test';
import {
  EMPTY_TASK_LAYOUT,
  reconcileTaskLayout,
  reconcilePanesIntoGroups,
  syncRowsWithGroups,
  activatePane,
  reorderGroupPanes,
  movePaneBetweenGroups,
  splitGroup,
  reorderRows,
  sanitizeTaskLayout,
  tabToPane,
  paneIdToContextId,
  forgetTaskLayout,
  getTaskLayout,
  taskBrowserLayout,
  canAutoActivateTaskPane,
  type GenId,
  type TaskLayoutState,
} from './taskBrowserLayout';

const mkGen = (): GenId => { let n = 0; return () => `g${++n}`; };
const build = (paneIds: string[], gen: GenId = mkGen()): TaskLayoutState =>
  reconcileTaskLayout(EMPTY_TASK_LAYOUT, paneIds, gen);

const P = (n: string) => `browser:${n}`;

describe('reconcileTaskLayout — build from tabs', () => {
  test('empty state + panes → one group, one row, focus set', () => {
    const s = build([P('a'), P('b')]);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].paneIds).toEqual([P('a'), P('b')]);
    expect(s.groups[0].activePaneId).toBe(P('b')); // newest orphan active
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].groupIds).toEqual([s.groups[0].id]);
    expect(s.rowHeights).toEqual([1]);
    expect(s.focusedGroupId).toBe(s.groups[0].id);
  });
  test('no panes → empty, stable reference', () => {
    expect(reconcileTaskLayout(EMPTY_TASK_LAYOUT, [])).toBe(EMPTY_TASK_LAYOUT);
  });
  test('idempotent: reconciling a settled state returns the same reference', () => {
    const s = build([P('a'), P('b')]);
    expect(reconcileTaskLayout(s, [P('a'), P('b')])).toBe(s);
  });
  test('a new tab is appended to the focused group and becomes active', () => {
    const s1 = build([P('a')]);
    const s2 = reconcileTaskLayout(s1, [P('a'), P('c')]);
    expect(s2.groups).toHaveLength(1);
    expect(s2.groups[0].paneIds).toEqual([P('a'), P('c')]);
    expect(s2.groups[0].activePaneId).toBe(P('c'));
  });
});

describe('reconcileTaskLayout — prune closed/parked tabs', () => {
  test('a removed pane is dropped from its group', () => {
    const s1 = build([P('a'), P('b')]);
    const s2 = reconcileTaskLayout(s1, [P('a')]);
    expect(s2.groups[0].paneIds).toEqual([P('a')]);
  });
  test('closing the active pane refocuses a survivor', () => {
    const s1 = build([P('a'), P('b')]); // active b
    const s2 = reconcileTaskLayout(s1, [P('a')]); // b gone
    expect(s2.groups[0].activePaneId).toBe(P('a'));
  });
  test('emptying a split group drops the group and its row column', () => {
    const gen = mkGen();
    let s = build([P('a'), P('b')], gen);
    const g0 = s.groups[0].id;
    s = splitGroup(s, g0, P('b'), g0, 'right', undefined, gen); // b → its own column
    expect(s.groups).toHaveLength(2);
    expect(s.rows[0].groupIds).toHaveLength(2);
    // now b closes → its group + column vanish, a's group stays full-width
    s = reconcileTaskLayout(s, [P('a')]);
    expect(s.groups).toHaveLength(1);
    expect(s.rows[0].groupIds).toEqual([s.groups[0].id]);
    expect(s.rows[0].widths).toEqual([1]);
  });
});

describe('splitGroup — side (columns)', () => {
  test('split right creates a second column with halved donor width', () => {
    const gen = mkGen();
    let s = build([P('a'), P('b')], gen);
    const g0 = s.groups[0].id;
    s = splitGroup(s, g0, P('b'), g0, 'right', undefined, gen);
    expect(s.groups).toHaveLength(2);
    expect(s.rows[0].groupIds).toHaveLength(2);
    expect(s.rows[0].widths).toEqual([0.5, 0.5]);
    // the new (rightmost) group holds the soloed pane and is focused
    const newG = s.groups.find((g) => g.paneIds.includes(P('b')) && g.paneIds.length === 1)!;
    expect(s.focusedGroupId).toBe(newG.id);
    expect(s.rows[0].groupIds[1]).toBe(newG.id);
  });
  test('splitting the last pane of a solo group is a no-op', () => {
    const gen = mkGen();
    const s = build([P('a')], gen);
    const g0 = s.groups[0].id;
    expect(splitGroup(s, g0, P('a'), g0, 'right', undefined, gen)).toBe(s);
  });
});

describe('splitGroup — vertical column stack + full row', () => {
  test('bottom split (column) stacks under the target via cellStacks', () => {
    const gen = mkGen();
    let s = build([P('a'), P('b')], gen);
    const g0 = s.groups[0].id;
    s = splitGroup(s, g0, P('b'), g0, 'bottom', undefined, gen);
    expect(s.rows).toHaveLength(1); // no new row
    const primary = s.rows[0].groupIds[0];
    expect(s.rows[0].cellStacks?.[primary]?.groupIds).toHaveLength(1);
  });
  test('full-row split inserts a spanning row + splits heights', () => {
    const gen = mkGen();
    let s = build([P('a'), P('b')], gen);
    const g0 = s.groups[0].id;
    s = splitGroup(s, g0, P('b'), g0, 'bottom', { fullRow: true }, gen);
    expect(s.rows).toHaveLength(2);
    expect(s.rowHeights).toHaveLength(2);
    expect(s.rowHeights[0] + s.rowHeights[1]).toBeCloseTo(1, 5);
  });
});

describe('movePaneBetweenGroups', () => {
  test('moves a pane and drops an emptied source group + column', () => {
    const gen = mkGen();
    let s = build([P('a'), P('b')], gen);
    const g0 = s.groups[0].id;
    s = splitGroup(s, g0, P('b'), g0, 'right', undefined, gen); // two groups
    const gA = s.groups.find((g) => g.paneIds.includes(P('a')))!;
    const gB = s.groups.find((g) => g.paneIds.includes(P('b')))!;
    // move b back into a's group → gB empties and is dropped
    s = movePaneBetweenGroups(s, gB.id, gA.id, P('b'), 1);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].paneIds).toEqual([P('a'), P('b')]);
    expect(s.groups[0].activePaneId).toBe(P('b'));
    expect(s.rows[0].groupIds).toEqual([s.groups[0].id]);
  });
});

describe('reorderGroupPanes / activatePane / reorderRows', () => {
  test('reorderGroupPanes reorders within a group', () => {
    const s = build([P('a'), P('b')]);
    const g0 = s.groups[0].id;
    const s2 = reorderGroupPanes(s, g0, [P('b'), P('a')]);
    expect(s2.groups[0].paneIds).toEqual([P('b'), P('a')]);
  });
  test('activatePane sets active + focus, no-op when already active+focused', () => {
    const s = build([P('a'), P('b')]);
    const g0 = s.groups[0].id;
    const s2 = activatePane(s, g0, P('a'));
    expect(s2.groups[0].activePaneId).toBe(P('a'));
    expect(s2.focusedGroupId).toBe(g0);
    expect(activatePane(s2, g0, P('a'))).toBe(s2);
  });
  test('reorderRows permutes rows + heights together', () => {
    const gen = mkGen();
    let s = build([P('a'), P('b')], gen);
    const g0 = s.groups[0].id;
    s = splitGroup(s, g0, P('b'), g0, 'bottom', { fullRow: true }, gen); // 2 rows
    const before = s.rows.map((r) => r.groupIds[0]);
    const s2 = reorderRows(s, [1, 0]);
    expect(s2.rows.map((r) => r.groupIds[0])).toEqual([before[1], before[0]]);
    expect(s2.rowHeights).toHaveLength(2);
  });
});

describe('reconcilePanesIntoGroups / syncRowsWithGroups (units)', () => {
  test('reconcilePanesIntoGroups is a no-op when everything is placed', () => {
    const s = build([P('a')]);
    const r = reconcilePanesIntoGroups(s.groups, [P('a')], s.focusedGroupId);
    expect(r.changed).toBe(false);
    expect(r.groups).toBe(s.groups);
  });
  test('shouldActivateOrphan: a non-browser orphan does NOT steal the active slot', () => {
    const s = build([P('a')]);                       // group active = browser:a
    const activeBefore = s.groups[0].activePaneId;
    const r = reconcilePanesIntoGroups(
      s.groups, [P('a'), 'plan:t'], s.focusedGroupId, mkGen(),
      canAutoActivateTaskPane,
    );
    expect(r.changed).toBe(true);
    const g = r.groups.find((x) => x.paneIds.includes('plan:t'))!;
    expect(g.activePaneId).toBe(activeBefore);        // still browser:a, not plan:t
  });
  test('shouldActivateOrphan: a browser orphan still activates', () => {
    const s = build([P('a')]);
    const r = reconcilePanesIntoGroups(
      s.groups, [P('a'), P('b')], s.focusedGroupId, mkGen(),
      canAutoActivateTaskPane,
    );
    const g = r.groups.find((x) => x.paneIds.includes(P('b')))!;
    expect(g.activePaneId).toBe(P('b'));
  });
});

/**
 * The predicate the drawer actually passes. The tests above used to hand
 * `reconcilePanesIntoGroups` a copy of the rule written by hand, which proved
 * the reconcile right and the rule nothing: this exercises the real one.
 */
describe('canAutoActivateTaskPane', () => {
  test('the task conversation and the browser tabs may come forward', () => {
    expect(canAutoActivateTaskPane('browser:ctx')).toBe(true);
    expect(canAutoActivateTaskPane('thread:t1')).toBe(true);
    expect(canAutoActivateTaskPane('session:t1')).toBe(true);
  });
  test('a plan or an attachment appearing mid-read may NOT', () => {
    expect(canAutoActivateTaskPane('plan:t1')).toBe(false);
    expect(canAutoActivateTaskPane('media:/a/b.png')).toBe(false);
  });
  test('a just-dispatched task opens ON the session, not on the plan', () => {
    // Nothing placed yet: the empty layout mints a group and the LAST orphan
    // that qualifies wins the active slot. The session is composed before the
    // plan, so a task delivering both must still land on the session.
    const s = reconcileTaskLayout(
      EMPTY_TASK_LAYOUT, ['session:t1', 'plan:t1'], mkGen(), canAutoActivateTaskPane,
    );
    expect(s.groups[0].activePaneId).toBe('session:t1');
  });
  test('a browser tab born in the same pass still outranks the session', () => {
    const s = reconcileTaskLayout(
      EMPTY_TASK_LAYOUT, ['session:t1', P('a')], mkGen(), canAutoActivateTaskPane,
    );
    expect(s.groups[0].activePaneId).toBe(P('a'));
  });
  test('syncRowsWithGroups appends an orphan group to a row', () => {
    const groups = [
      { id: 'gX', paneIds: [P('a')], activePaneId: P('a'), type: 'utility' as const },
      { id: 'gY', paneIds: [P('b')], activePaneId: P('b'), type: 'utility' as const },
    ];
    const r = syncRowsWithGroups(groups, [{ groupIds: ['gX'], widths: [1] }], [1]);
    expect(r.changed).toBe(true);
    expect(r.rows[0].groupIds).toEqual(['gX', 'gY']);
  });
});

describe('sanitizeTaskLayout', () => {
  test('rejects malformed payloads', () => {
    expect(sanitizeTaskLayout(null)).toBeNull();
    expect(sanitizeTaskLayout({})).toBeNull();
    expect(sanitizeTaskLayout({ groups: [{}], rows: [], rowHeights: [] })).toBeNull();
    expect(sanitizeTaskLayout({ groups: [], rows: [{ groupIds: 'x', widths: [] }], rowHeights: [] })).toBeNull();
  });
  test('round-trips a valid layout incl. cellStacks', () => {
    const s = sanitizeTaskLayout({
      groups: [{ id: 'g1', paneIds: [P('a'), P('b')], activePaneId: P('a'), type: 'utility' }],
      rows: [{ groupIds: ['g1'], widths: [1], cellStacks: { g1: { groupIds: ['g2'], heights: [0.5, 0.5] } } }],
      rowHeights: [1],
      focusedGroupId: 'g1',
    });
    expect(s?.groups[0].paneIds).toEqual([P('a'), P('b')]);
    expect(s?.rows[0].cellStacks?.g1.groupIds).toEqual(['g2']);
    expect(s?.focusedGroupId).toBe('g1');
  });
});

describe('tabToPane / paneIdToContextId', () => {
  test('maps a tab to a browser Pane and back', () => {
    const pane = tabToPane({ contextId: 'task-abc-0', url: 'https://x', title: 'X', titleSource: 'user' });
    expect(pane).toMatchObject({ id: 'browser:task-abc-0', type: 'browser', stableKey: 'task-abc-0', url: 'https://x', title: 'X', titleSource: 'user' });
    expect(paneIdToContextId('browser:task-abc-0')).toBe('task-abc-0');
    expect(paneIdToContextId('task-abc-0')).toBe('task-abc-0');
  });
});

// ── il task è stato archiviato: si dimentica il layout ───────────────────────
// Il server ha appena CANCELLATO `task-browser-layout:<id>`. La riga torna in
// vita se questo client lascia partire il PUT che ha in coda — quindi la prova
// è che quel PUT NON parta. Il caso di controllo (senza `forget`) parte davvero:
// senza di lui questo test non potrebbe fallire.

const flushDebounce = () => new Promise((r) => setTimeout(r, 900));

describe('forgetTaskLayout (task archiviato)', () => {
  test('annulla il PUT in coda — e senza forget quel PUT parte', async () => {
    const real = globalThis.fetch;
    const puts: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(String(url));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      // controllo: il debounce esiste davvero e scrive
      const vivo = 'layout-vivo-1';
      taskBrowserLayout.set(vivo, build([P('a')]));
      await flushDebounce();
      expect(puts).toEqual([`/api/ui-state/task-browser-layout:${vivo}`]);

      // archiviato: stessa mossa, ma la chiave viene dimenticata prima
      const morto = 'layout-morto-1';
      taskBrowserLayout.set(morto, build([P('b')]));
      expect(getTaskLayout(morto).groups).toHaveLength(1);
      forgetTaskLayout(morto);
      expect(getTaskLayout(morto)).toBe(EMPTY_TASK_LAYOUT);
      await flushDebounce();
      expect(puts.filter((u) => u.includes(morto))).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });
});
