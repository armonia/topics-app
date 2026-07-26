import { describe, it, expect, beforeEach } from 'bun:test';
import {
  publishWorkspaceGroups,
  useWorkspaceGroupsStore,
  type WorkspaceGroup,
} from './workspaceGroups';

const read = () => useWorkspaceGroupsStore.getState().groups;

describe('workspaceGroups', () => {
  beforeEach(() => {
    useWorkspaceGroupsStore.setState({ groups: [] });
  });

  it('publishes the composition', () => {
    const groups: WorkspaceGroup[] = [
      { key: 'standalone', paneIds: ['a', 'b'] },
      { key: 'solo:c', paneIds: ['c'] },
    ];
    publishWorkspaceGroups(groups);
    expect(read()).toEqual(groups);
  });

  // The publish runs from a PanelGrid effect that re-fires whenever
  // naturalGridItems is re-derived — which happens on unrelated renders too.
  // Without the equality guard every one of those would set() a fresh array and
  // re-render every subscriber (the sidebar) for nothing.
  it('does NOT change the state identity when the composition is identical', () => {
    publishWorkspaceGroups([{ key: 'standalone', paneIds: ['a', 'b'] }]);
    const first = read();
    publishWorkspaceGroups([{ key: 'standalone', paneIds: ['a', 'b'] }]);
    expect(read()).toBe(first);
  });

  it('detects a reorder within a group', () => {
    publishWorkspaceGroups([{ key: 'standalone', paneIds: ['a', 'b'] }]);
    const first = read();
    publishWorkspaceGroups([{ key: 'standalone', paneIds: ['b', 'a'] }]);
    expect(read()).not.toBe(first);
    expect(read()[0].paneIds).toEqual(['b', 'a']);
  });

  it('detects a new cell, a dropped cell and a renamed key', () => {
    publishWorkspaceGroups([{ key: 'standalone', paneIds: ['a'] }]);
    publishWorkspaceGroups([
      { key: 'standalone', paneIds: ['a'] },
      { key: 'solo:b', paneIds: ['b'] },
    ]);
    expect(read()).toHaveLength(2);

    publishWorkspaceGroups([{ key: 'standalone', paneIds: ['a'] }]);
    expect(read()).toHaveLength(1);

    const before = read();
    publishWorkspaceGroups([{ key: 'solo:a', paneIds: ['a'] }]);
    expect(read()).not.toBe(before);
    expect(read()[0].key).toBe('solo:a');
  });

  it('clears on unmount-style publish of an empty list', () => {
    publishWorkspaceGroups([{ key: 'standalone', paneIds: ['a'] }]);
    publishWorkspaceGroups([]);
    expect(read()).toEqual([]);
  });
});
