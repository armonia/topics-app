/**
 * @covers TOPIC-BROWSER-04
 * The door is asked ONE question, so these are its answers.
 *
 * Worth pinning without a renderer: the two refusals are what keeps the change
 * off every other open path in the app. A conversation that cannot host a
 * window (a draft, a phone, a chat pane that is not the one drawing it)
 * registers nothing and must behave exactly as it did before, and a link
 * clicked inside a browser pane belongs to that pane's strip whatever
 * conversation it sits next to.
 *
 * NOTHING HERE MOUNTS A WINDOW, and that is the point of the change: the door
 * is the chat's, so it answers for a topic whose window does not exist yet.
 */
import { describe, expect, it } from 'bun:test';
import { openInTopicWindow, registerTopicWindowDoor, topicWindowTakesLink, type TopicWindowSheet } from './topicWindowDoor';
import type { OpenTabDetail } from './openLink';

const link = (over: Partial<OpenTabDetail> = {}): OpenTabDetail => ({
  url: 'https://example.test/page',
  contextId: 'ctx-1',
  ...over,
});

describe('topicWindowDoor', () => {
  it('the chat of a topic takes the links of its own conversation, window or not', () => {
    const taken: TopicWindowSheet[] = [];
    const stop = registerTopicWindowDoor('t1', (s) => { taken.push(s); return true; });
    expect(topicWindowTakesLink(link({ topicId: 't1' }))).toBe(true);
    expect(taken).toEqual([{ contextId: 'ctx-1', url: 'https://example.test/page', openedBy: 'link' }]);
    stop();
  });

  it('a topic with no open door answers nothing, and the link carries on', () => {
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

  it('the agent and the slash command use the same door, with their own mode', () => {
    const taken: TopicWindowSheet[] = [];
    const stop = registerTopicWindowDoor('t1', (s) => { taken.push(s); return true; });
    // The agent's open: it wakes a hidden window, it does not take the screen.
    expect(openInTopicWindow('t1', { contextId: 't1', url: 'https://a.test/', openedBy: 'agent' })).toBe(true);
    // `/browser` is an explicit request to LOOK, so it asks for the expanded one.
    expect(openInTopicWindow('t1', { contextId: 't1', url: 'https://b.test/', openedBy: 'user', mode: 'exp' })).toBe(true);
    expect(taken.map((s) => s.mode)).toEqual([undefined, 'exp']);
    stop();
  });

  it('no topic and no contextId are refusals, not a throw', () => {
    const stop = registerTopicWindowDoor('t1', () => true);
    expect(openInTopicWindow(undefined, { contextId: 't1', url: 'https://a.test/', openedBy: 'agent' })).toBe(false);
    expect(openInTopicWindow('t1', { contextId: '', url: 'https://a.test/', openedBy: 'agent' })).toBe(false);
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
