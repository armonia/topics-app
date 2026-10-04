/**
 * Taking a page out of the layout because the window record says it is a sheet
 * (`releaseArrivedSheetFromLayout`). Asked by identity, so a page nobody here
 * holds is left alone.
 * @covers TOPIC-BROWSER-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { releaseArrivedSheetFromLayout } from './reclaimFromLayout';
import { publishProjectBrowserPanes } from '../../state/pane/adapters/projectBrowserPanes';
import { usePaneStore } from '../../state/pane/store';

describe('releaseArrivedSheetFromLayout (a page put back elsewhere)', () => {
  const PROJECT = '/tmp/release-arrived-project';
  let stopPublishing: () => void = () => {};

  beforeEach(() => {
    usePaneStore.setState({ panes: {}, groups: {}, closedStack: [], tombstones: {} });
  });
  afterEach(() => {
    stopPublishing();
    stopPublishing = () => {};
    usePaneStore.setState({ panes: {}, groups: {}, closedStack: [], tombstones: {} });
  });

  test('a PROJECT pane holding the page is reclaimed through its project window', () => {
    const reclaimed: string[] = [];
    stopPublishing = publishProjectBrowserPanes(
      PROJECT,
      [{ contextId: 'ctx-p', url: 'https://example.test/p', title: 'P' }],
      (id) => { reclaimed.push(id); },
    );

    expect(releaseArrivedSheetFromLayout('ctx-p')).toBe(true);
    expect(reclaimed).toEqual(['ctx-p']);
  });

  test('a WORKSPACE pane holding the page leaves the pane store, without an undo record', () => {
    usePaneStore.getState().dispatch({
      type: 'OPEN_PANE',
      payload: { id: 'browser:ctx-w', type: 'browser', title: 'W', groupId: 'g1' },
    });

    expect(releaseArrivedSheetFromLayout('ctx-w')).toBe(true);
    const state = usePaneStore.getState();
    expect(state.panes['browser:ctx-w']).toBeUndefined();
    expect(state.closedStack.some((c) => c.pane.id === 'browser:ctx-w')).toBe(false);
  });

  test('a page no layout here holds touches nothing', () => {
    const reclaimed: string[] = [];
    stopPublishing = publishProjectBrowserPanes(
      PROJECT,
      [{ contextId: 'ctx-other', url: '', title: '' }],
      (id) => { reclaimed.push(id); },
    );

    expect(releaseArrivedSheetFromLayout('ctx-new')).toBe(false);
    expect(reclaimed).toEqual([]);
    expect(usePaneStore.getState().tombstones?.['browser:ctx-new']).toBeUndefined();
  });
});
