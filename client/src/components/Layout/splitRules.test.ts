/**
 * Which panes can be split, and onto which surface a standalone grid key maps.
 *
 * @covers LAYOUT-01
 */
import { describe, it, expect } from 'bun:test';
import { canSplitPane, canDropSplit, standaloneSplitSurface } from './splitRules';

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
