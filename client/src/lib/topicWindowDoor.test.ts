/**
 * The door is asked ONE question, so these are its three answers.
 *
 * Worth pinning without a renderer: the two refusals are what keeps the change
 * off every other open path in the app. A topic with no window must behave
 * exactly as it did before, and a link clicked inside a browser pane belongs to
 * that pane's strip whatever conversation it sits next to.
 */
import { describe, expect, it } from 'bun:test';
import { registerTopicWindowDoor, topicWindowTakesLink } from './topicWindowDoor';
import type { OpenTabDetail } from './openLink';

const link = (over: Partial<OpenTabDetail> = {}): OpenTabDetail => ({
  url: 'https://example.test/page',
  contextId: 'ctx-1',
  ...over,
});

describe('topicWindowDoor', () => {
  it('the topic that has a window takes the links of its own chat', () => {
    const taken: string[] = [];
    const stop = registerTopicWindowDoor('t1', (d) => { taken.push(d.contextId); return true; });
    expect(topicWindowTakesLink(link({ topicId: 't1' }))).toBe(true);
    expect(taken).toEqual(['ctx-1']);
    stop();
  });

  it('a topic with no window answers nothing, and the link carries on', () => {
    const stop = registerTopicWindowDoor('t1', () => true);
    expect(topicWindowTakesLink(link({ topicId: 'another' }))).toBe(false);
    expect(topicWindowTakesLink(link())).toBe(false);
    stop();
  });

  it('a link clicked inside a browser pane stays in that strip', () => {
    const stop = registerTopicWindowDoor('t1', () => true);
    expect(topicWindowTakesLink(link({ topicId: 't1', nearPaneId: 'browser:other' }))).toBe(false);
    stop();
  });

  it('un-registering only drops the door that is still the registered one', () => {
    const stopFirst = registerTopicWindowDoor('t1', () => true);
    // A remount registers BEFORE the previous effect cleans up: the stale
    // release must not shut the live door.
    const stopSecond = registerTopicWindowDoor('t1', () => true);
    stopFirst();
    expect(topicWindowTakesLink(link({ topicId: 't1' }))).toBe(true);
    stopSecond();
    expect(topicWindowTakesLink(link({ topicId: 't1' }))).toBe(false);
  });
});
