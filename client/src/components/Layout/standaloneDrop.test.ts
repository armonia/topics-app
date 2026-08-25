/**
 * Dragging a tab across groups in the standalone grid: a drop onto another
 * split cell merges into it at the indicated index instead of collapsing it,
 * and a drop onto the main pool un-splits the dragged tab.
 *
 * @covers LAYOUT-01, LAYOUT-02
 */
import { describe, test, expect } from 'bun:test';
import { resolveStandaloneCrossGroupDrop as resolve } from './standaloneDrop';

// `sourcePaneId` is the dragged tab's PANE id (a bare topic id like 'A', or
// 'chat:A'); `sourceGroupId`/`targetGroupId` are the CELL grid keys ('solo:A' or
// 'standalone'). Different values for the same topic.
const base = {
  canAcceptSolo: true,
  canMergeIntoCell: true,
};

describe('resolveStandaloneCrossGroupDrop', () => {
  test('THE FEATURE: drop onto another split cell MERGES into it (no collapse)', () => {
    const d = resolve({ ...base, sourcePaneId: 'A', sourceGroupId: 'solo:A', targetGroupId: 'solo:B', targetTopicIds: ['B'] });
    expect(d).toEqual({ kind: 'merge-into-cell', draggedTopicId: 'A', targetPrimary: 'B' });
  });

  test('drop onto a populated (multi-tab) split cell also merges', () => {
    const d = resolve({ ...base, sourcePaneId: 'A', sourceGroupId: 'solo:A', targetGroupId: 'solo:B', targetTopicIds: ['B', 'C'] });
    expect(d).toEqual({ kind: 'merge-into-cell', draggedTopicId: 'A', targetPrimary: 'B' });
  });

  test('a pool tab dropped onto a split cell joins that cell', () => {
    const d = resolve({ ...base, sourcePaneId: 'W', sourceGroupId: 'standalone', targetGroupId: 'solo:B', targetTopicIds: ['B'] });
    expect(d).toEqual({ kind: 'merge-into-cell', draggedTopicId: 'W', targetPrimary: 'B' });
  });

  test('drop onto the main pool un-splits the dragged tab', () => {
    const d = resolve({ ...base, sourcePaneId: 'A', sourceGroupId: 'solo:A', targetGroupId: 'standalone', targetTopicIds: ['X', 'Y'] });
    expect(d).toEqual({ kind: 'unsolo-dragged', draggedTopicId: 'A' });
  });

  test('self/sibling drop onto own bar is a no-op', () => {
    expect(resolve({ ...base, sourcePaneId: 'A', sourceGroupId: 'solo:A', targetGroupId: 'solo:A', targetTopicIds: ['A'] }))
      .toEqual({ kind: 'noop' });
  });

  test('without merge support, solo→solo degrades to non-destructive unsolo (no collapse)', () => {
    const d = resolve({ ...base, canMergeIntoCell: false, sourcePaneId: 'A', sourceGroupId: 'solo:A', targetGroupId: 'solo:B', targetTopicIds: ['B'] });
    expect(d).toEqual({ kind: 'unsolo-dragged', draggedTopicId: 'A' });
  });

  test('foreign project chat (chat: paneid) is a no-op — project tabs never pass the scope guard', () => {
    const d = resolve({ ...base, sourcePaneId: 'chat:Z', sourceGroupId: 'standalone', targetGroupId: 'solo:B', targetTopicIds: ['B'] });
    expect(d).toEqual({ kind: 'noop' });
  });

  test('a topic already present in the target is a no-op', () => {
    const d = resolve({ ...base, sourcePaneId: 'B', sourceGroupId: 'standalone', targetGroupId: 'solo:B', targetTopicIds: ['B'] });
    expect(d).toEqual({ kind: 'noop' });
  });

  test('missing handlers degrade to no-op', () => {
    const d = resolve({
      canAcceptSolo: false, canMergeIntoCell: false,
      sourcePaneId: 'A', sourceGroupId: 'solo:A', targetGroupId: 'solo:B', targetTopicIds: ['B'],
    });
    expect(d).toEqual({ kind: 'noop' });
  });

  test('insertIdx travels with the merge decision (drop indicators honored)', () => {
    const d = resolve({ ...base, insertIdx: 1, sourcePaneId: 'A', sourceGroupId: 'solo:A', targetGroupId: 'solo:B', targetTopicIds: ['B', 'C'] });
    expect(d).toEqual({ kind: 'merge-into-cell', draggedTopicId: 'A', targetPrimary: 'B', insertIdx: 1 });
  });
});
