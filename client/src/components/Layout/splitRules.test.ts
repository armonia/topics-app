/**
 * Which panes can be split, and onto which surface a standalone grid key maps.
 *
 * @covers LAYOUT-01
 */
import { describe, it, expect } from 'bun:test';
import { canSplitPane, canDropSplit, standaloneSplitSurface, standaloneEdgeDropSplits, centerDropMerges, standaloneCenterDropMerges, centerMergeTargetKey } from './splitRules';

describe('canSplitPane', () => {
  it('standalone pool is always splittable (single tab auto-spawns a draft companion)', () => {
    expect(canSplitPane({ surface: 'standalone-pool', groupSize: 1 })).toBe(true);
    expect(canSplitPane({ surface: 'standalone-pool', groupSize: 5 })).toBe(true);
  });

  it('solo cells split only when they hold more than one tab', () => {
    expect(canSplitPane({ surface: 'standalone-solo', groupSize: 1 })).toBe(false);
    expect(canSplitPane({ surface: 'standalone-solo', groupSize: 2 })).toBe(true);
  });

  it('project groups are always splittable (single-pane split auto-spawns a draft companion)', () => {
    // A single-pane group is now splittable: handleSplitGroup creates a fresh
    // draft in the source group so it retains one visible pane, mirroring the
    // standalone-pool behaviour (PanelGrid auto-spawns a draft there too).
    expect(canSplitPane({ surface: 'project', groupSize: 1 })).toBe(true);
    expect(canSplitPane({ surface: 'project', groupSize: 2 })).toBe(true);
    expect(canSplitPane({ surface: 'project', groupSize: 0 })).toBe(true);
  });
});

describe('standaloneSplitSurface', () => {
  it('maps grid keys to surfaces', () => {
    expect(standaloneSplitSurface('standalone')).toBe('standalone-pool');
    expect(standaloneSplitSurface('solo:abc')).toBe('standalone-solo');
  });
});

describe('canDropSplit — the drag path asks the menu\'s question', () => {
  it('a drop on ANOTHER group always splits, whatever the source held', () => {
    for (const sourceGroupSize of [1, 2, 7]) {
      expect(canDropSplit({ surface: 'project', sourceGroupSize, sameGroup: false })).toBe(true);
      expect(canDropSplit({ surface: 'standalone-solo', sourceGroupSize, sameGroup: false })).toBe(true);
    }
  });

  it('the reported failure: a project group holding ONE pane splits onto its own edge', () => {
    // This is the case the card names. The drop handler used to refuse it while
    // the menu offered it and handleSplitGroup implemented it, so a project
    // opened with a single pane painted the edge preview and swallowed the drop.
    expect(canDropSplit({ surface: 'project', sourceGroupSize: 1, sameGroup: true })).toBe(true);
  });

  it('agrees with canSplitPane on every self-drop, on every surface', () => {
    for (const surface of ['standalone-pool', 'standalone-solo', 'project'] as const) {
      for (const groupSize of [1, 2, 3]) {
        expect(canDropSplit({ surface, sourceGroupSize: groupSize, sameGroup: true }))
          .toBe(canSplitPane({ surface, groupSize }));
      }
    }
  });

  it('a full-row drop is refused only for the only pane of the only group', () => {
    const base = { surface: 'project', sameGroup: true, fullRow: true } as const;
    expect(canDropSplit({ ...base, sourceGroupSize: 1, totalGroups: 1 })).toBe(false);
    // Two groups: the source empties and disappears, the pane gets its own row.
    expect(canDropSplit({ ...base, sourceGroupSize: 1, totalGroups: 2 })).toBe(true);
    // A pane leaving a group that keeps others behind always reshapes.
    expect(canDropSplit({ ...base, sourceGroupSize: 2, totalGroups: 1 })).toBe(true);
  });
});

describe('standaloneEdgeDropSplits — the preview asks what the drop will answer', () => {
  // The drop refuses exactly one case (PanelGrid handleGridItemDropCapture):
  // the lone tab of a solo cell released on its OWN cell's edge. Everything
  // else reshapes, so everything else may be painted.
  it('the lone tab of a solo cell on its own edge is refused', () => {
    expect(standaloneEdgeDropSplits({
      targetCellKey: 'solo:A', draggedPaneId: 'A', targetCellSize: 1,
    })).toBe(false);
  });

  it('a chat pane id is translated to its topic before comparing', () => {
    expect(standaloneEdgeDropSplits({
      targetCellKey: 'solo:A', draggedPaneId: 'chat:A', targetCellSize: 1,
    })).toBe(false);
  });

  it('the primary of a MULTI-tab cell on its own edge is a real split', () => {
    expect(standaloneEdgeDropSplits({
      targetCellKey: 'solo:A', draggedPaneId: 'chat:A', targetCellSize: 2,
    })).toBe(true);
  });

  it('another cell edge always splits', () => {
    expect(standaloneEdgeDropSplits({
      targetCellKey: 'solo:B', draggedPaneId: 'chat:A', targetCellSize: 1,
    })).toBe(true);
  });

  it('the pool edge always splits', () => {
    expect(standaloneEdgeDropSplits({
      targetCellKey: 'standalone', draggedPaneId: 'chat:A', targetCellSize: 1,
    })).toBe(true);
  });

  it('a drag from another window is allowed: the shelf is empty there', () => {
    expect(standaloneEdgeDropSplits({
      targetCellKey: 'solo:A', draggedPaneId: null, targetCellSize: 1,
    })).toBe(true);
  });
});

describe('centerDropMerges — the centre of your OWN group', () => {
  it('refuses the centre of the group the tab already lives in', () => {
    expect(centerDropMerges({ draggedPaneId: 'p1', targetMemberIds: ['p1', 'p2'] })).toBe(false);
  });

  it('accepts the centre of any other group', () => {
    expect(centerDropMerges({ draggedPaneId: 'p1', targetMemberIds: ['p2'] })).toBe(true);
    expect(centerDropMerges({ draggedPaneId: 'p1', targetMemberIds: [] })).toBe(true);
  });

  it('accepts a drag from another window, where the shelf cannot answer', () => {
    expect(centerDropMerges({ draggedPaneId: null, targetMemberIds: ['p1'] })).toBe(true);
  });
});

describe('standaloneCenterDropMerges — the same question on the grid', () => {
  const cells = [['a', 'b'], ['c']];

  it('refuses a cell that already hosts the tab, primary or member', () => {
    expect(standaloneCenterDropMerges({ targetCellKey: 'solo:a', draggedPaneId: 'chat:a', soloCells: cells })).toBe(false);
    expect(standaloneCenterDropMerges({ targetCellKey: 'solo:a', draggedPaneId: 'chat:b', soloCells: cells })).toBe(false);
  });

  it('accepts a cell that does not host it', () => {
    expect(standaloneCenterDropMerges({ targetCellKey: 'solo:c', draggedPaneId: 'chat:a', soloCells: cells })).toBe(true);
  });

  it('refuses the pool for a tab that is already in the pool', () => {
    expect(standaloneCenterDropMerges({ targetCellKey: 'standalone', draggedPaneId: 'chat:z', soloCells: cells })).toBe(false);
  });

  it('accepts the pool for a tab that a solo cell holds', () => {
    expect(standaloneCenterDropMerges({ targetCellKey: 'standalone', draggedPaneId: 'chat:a', soloCells: cells })).toBe(true);
  });

  it('accepts a drag from another window', () => {
    expect(standaloneCenterDropMerges({ targetCellKey: 'solo:a', draggedPaneId: null, soloCells: cells })).toBe(true);
  });
});

describe('centerMergeTargetKey — a centre drop joins the pane under the pointer', () => {
  const known = (k: string) => ['standalone', 'solo:a', 'solo:b'].includes(k);

  it('prefers the slot under the pointer over its host cell', () => {
    // The stacked member `solo:b` lives inside the cell headed by `solo:a`:
    // releasing on ITS body must join it, not the pane above.
    expect(centerMergeTargetKey('solo:b', 'solo:a', known)).toBe('solo:b');
  });

  it('falls back to the cell when no slot is under the pointer', () => {
    expect(centerMergeTargetKey(null, 'solo:a', known)).toBe('solo:a');
    expect(centerMergeTargetKey(undefined, 'standalone', known)).toBe('standalone');
  });

  it('ignores a leaf this grid does not own', () => {
    // A `data-split-leaf` from a PROJECT layout nested in a standalone cell.
    expect(centerMergeTargetKey('group-77', 'solo:a', known)).toBe('solo:a');
  });
});
