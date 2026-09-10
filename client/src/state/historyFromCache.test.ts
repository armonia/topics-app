/**
 * A CHAT SERVING YESTERDAY'S ROWS SAYS SO, AND ONLY WHEN SAYING IT HELPS.
 *
 * `loadHistory` deliberately falls back to the device's cached transcript when
 * its fetch fails - that is what stops the pane emptying out on a hiccup of the
 * boot. What it did not do is say so: the flag it raised (`cachedSessions` plus
 * an `isSessionCached` getter inside `useChat`) had NO reader anywhere in the
 * repository, so a chat showing the answers of yesterday was pixel-identical to
 * one refreshed a second ago, on the most looked-at surface of the app.
 *
 * The second half is the gate. The status bar's `dataNotice` row has followed
 * this rule since it was written (`SidebarStatusBar.tsx`): while the WebSocket
 * is down, the connection alarm is already on screen saying the server is
 * unreachable, and a second amber line underneath reads as a SECOND failure.
 * Here the AND lives inside the read, so a call site cannot forget it.
 *
 * @covers CHAT-01
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { createElement, useEffect } from 'react';
import { mount } from '../test/reactHarness';
import { dispatchLifecycle } from '../lib/wsFrameBus';
import {
  _isFromCacheForTests,
  _resetForTests,
  _setSocketOpenForTests,
  clearHistoryFromCache,
  markHistoryFromCache,
  useServedFromCache,
} from './historyFromCache';

/** Mounts the real hook, the way `ChatPane` mounts it for its own session. */
function mountNotice(sessionKey: string) {
  const box = { shown: false };
  const Probe = (): null => {
    const shown = useServedFromCache(sessionKey);
    useEffect(() => { box.shown = shown; });
    return null;
  };
  const h = mount(createElement(Probe));
  return { shown: () => box.shown, unmount: () => h.unmount() };
}

beforeEach(() => { _resetForTests(); });

describe('historyFromCache: the flag', () => {
  test('a session is not stale until a fetch has failed on it', () => {
    expect(_isFromCacheForTests('topic:a')).toBe(false);
  });

  test('marking is per session, and a successful load clears just that one', () => {
    markHistoryFromCache('topic:a');
    markHistoryFromCache('topic:b');
    clearHistoryFromCache('topic:a');
    expect(_isFromCacheForTests('topic:a')).toBe(false);
    expect(_isFromCacheForTests('topic:b'), 'the other chat is still on its local copy').toBe(true);
  });
});

describe('historyFromCache: the notice only speaks with the socket up', () => {
  test('stale with the socket down stays quiet: the connection alarm owns that', () => {
    markHistoryFromCache('topic:a');
    const n = mountNotice('topic:a');
    expect(n.shown()).toBe(false);
    n.unmount();
  });

  test('the socket coming up is what makes the line appear, without a remount', () => {
    markHistoryFromCache('topic:a');
    const n = mountNotice('topic:a');
    _setSocketOpenForTests(true);
    expect(n.shown(), 'the store woke the pane: no remount was needed').toBe(true);
    n.unmount();
  });

  test('and the socket going down takes it away again', () => {
    markHistoryFromCache('topic:a');
    const n = mountNotice('topic:a');
    _setSocketOpenForTests(true);
    _setSocketOpenForTests(false);
    expect(n.shown()).toBe(false);
    n.unmount();
  });

  test('a socket that is up says nothing about a chat that loaded fine', () => {
    _setSocketOpenForTests(true);
    const n = mountNotice('topic:a');
    expect(n.shown()).toBe(false);
    n.unmount();
  });

  test('a successful retry takes the line down while the socket stays up', () => {
    markHistoryFromCache('topic:a');
    _setSocketOpenForTests(true);
    const n = mountNotice('topic:a');
    expect(n.shown()).toBe(true);
    clearHistoryFromCache('topic:a');
    expect(n.shown(), 'the server answered: the pane stops saying it did not').toBe(false);
    n.unmount();
  });

  test('two chats, one stale: the other one says nothing', () => {
    markHistoryFromCache('topic:a');
    _setSocketOpenForTests(true);
    const a = mountNotice('topic:a');
    const b = mountNotice('topic:b');
    expect([a.shown(), b.shown()]).toEqual([true, false]);
    a.unmount();
    b.unmount();
  });
});

describe('historyFromCache: the socket is read from the bus, not from a status', () => {
  test("the bus's own open and close move the gate", () => {
    // `dispatchLifecycle` is what `useWebSocket` calls inside `ws.onopen` /
    // `ws.onclose`. The smoothed `wsStatus` is deliberately NOT the input: it
    // holds 'connected' for three seconds so the bar does not blink, and
    // reading it would show this notice next to a connection alarm for exactly
    // those three seconds - the pairing the gate exists to prevent.
    markHistoryFromCache('topic:a');
    const n = mountNotice('topic:a');
    dispatchLifecycle('open');
    expect(n.shown()).toBe(true);
    dispatchLifecycle('close');
    expect(n.shown()).toBe(false);
    // The flag itself never moved: a closed socket hides the line, it does not
    // decide that the rows are fresh again.
    expect(_isFromCacheForTests('topic:a')).toBe(true);
    n.unmount();
  });
});
