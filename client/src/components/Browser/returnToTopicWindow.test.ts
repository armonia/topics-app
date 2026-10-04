/**
 * @covers TOPIC-BROWSER-01
 * THE WAY HOME EXISTS EXACTLY WHEN THE PAGE WAS LENT.
 *
 * On the web there is only the streaming panel, so if this command is missing
 * there a promoted tab has no reachable way back at all: the window is down to
 * its bar and the "+" menu is the only other door. The rule is one line, and
 * it is the line that decides whether the person is stuck.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { __resetProjectSyncForTests } from '../../state/pane/adapters/projectLayoutSync';
import { returnCommandFor, releaseArrivedSheetFromLayout } from './returnToTopicWindow';
import { publishProjectBrowserPanes } from '../../state/pane/adapters/projectBrowserPanes';
import { usePaneStore } from '../../state/pane/store';
import {
  topicBrowserWindow,
  getTopicWindow,
  findTopicOwningPromoted,
  __resetTopicWindows,
} from '../../state/topicBrowserWindow';

describe('the return-to-chat command of a promoted tab', () => {
  beforeEach(() => {
    __resetTopicWindows();
  });

  // Lending a page and taking it back leave state in TWO stores. The one that
  // actually leaks across files is the window store: without the reset below
  // the windows of one test are still standing in the next (measured: it is
  // `__resetTopicWindows`, not the project layout, that keeps the pair green).
  // The project-sync reset rides along for its debounced layout write.
  afterEach(() => {
    __resetTopicWindows();
    __resetProjectSyncForTests();
  });

  test('an ordinary tab nobody lent has no command at all', () => {
    expect(returnCommandFor(null, { contextId: 'ctx-a' })).toBeUndefined();
  });

  test('a lent page has a command, and taking it puts the page back', () => {
    const topic = 'topic-1';
    topicBrowserWindow.open(topic, { contextId: 'ctx-a', url: 'https://example.test/a' });
    topicBrowserWindow.promoteToTab(topic, 'ctx-a');
    expect(getTopicWindow(topic).promoted).toContain('ctx-a');

    const owner = findTopicOwningPromoted('ctx-a');
    expect(owner).toBe(topic);

    const back = returnCommandFor(owner, { contextId: 'ctx-a', url: 'https://example.test/a' });
    expect(back).toBeDefined();
    back?.();

    const after = getTopicWindow(topic);
    expect(after.promoted).not.toContain('ctx-a');
    expect(after.tabs.map((s) => s.contextId)).toContain('ctx-a');
    expect(after.activeContextId).toBe('ctx-a');
  });
});

/**
 * The other half of a return made on ANOTHER device: the window record says the
 * page is a sheet again, and the layout here lets go of it. Asked by identity,
 * so a page nobody here holds is left alone.
 */
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
