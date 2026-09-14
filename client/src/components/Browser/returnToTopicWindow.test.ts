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
import { returnCommandFor } from './returnToTopicWindow';
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
