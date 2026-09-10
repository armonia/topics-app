/**
 * WHICH CHATS ARE SHOWING THE COPY THIS DEVICE ALREADY HAD.
 *
 * `loadHistory` (useChat) serves the device's cached transcript when the fetch
 * fails, and that is a deliberate choice, not a bug: the alternative is an
 * empty pane, or an error banner flashing on every hiccup of the boot, over
 * messages that ARE the ones the server had last time it answered. What was
 * missing is the sentence saying so. The flag existed - `cachedSessions` plus
 * an `isSessionCached` getter inside `useChat` - and in the whole repository
 * NOBODY read it: a chat serving yesterday's rows looked exactly like a chat
 * that had just been refreshed, on the most looked-at surface of the app.
 *
 * It lives out here, and not in `useChat`, for two measured reasons. That hook
 * is mounted ONCE for the whole app, so a `Set` in its state re-rendered every
 * pane on screen to say something about one of them (the same reason `error`,
 * `loading` and `streaming` up there are keyed by session). And the chat pane
 * is four components below that hook - App, StandaloneChatGroup /
 * ProjectWindow, ChatPanel, ChatPane - so a prop would have travelled through
 * three components that have nothing to do with it, and through
 * `chatPanePropsEqual`, which would have had to learn about it too.
 *
 * THE NOTICE IS GATED ON THE SOCKET, and the gate is inside the read on
 * purpose. It is the rule the status bar's `dataNotice` row already follows
 * (`SidebarStatusBar.tsx`): while the WebSocket is down, the connection alarm
 * is already on screen saying the server is unreachable, and a second amber
 * line under it reads as a SECOND failure. `useServedFromCache` ANDs the two,
 * so the call site cannot forget the rule.
 */
import { useSyncExternalStore } from 'react';
import { subscribeLifecycle } from '../lib/wsFrameBus';

/** Session keys whose last `loadHistory` fell back to the local copy. */
const fromCache = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Is the socket open RIGHT NOW.
 *
 * Seeded `false`, and that is the honest seed: before the first `open` nobody
 * has connected to anything yet. It also happens to be the quiet one - the
 * first socket of a reload lands 300-500 ms after the first paint, so a boot
 * whose history fetch failed says nothing until the connection has had its
 * chance, instead of flashing a notice at a page that is still arriving.
 *
 * Not `useWebSocket`'s status: that one is deliberately SMOOTHED (it keeps
 * saying `connected` for three seconds so the bar does not blink), and reading
 * a smoothed value here would show this notice next to a connection alarm for
 * exactly those three seconds, which is the pairing the gate exists to prevent.
 */
let socketOpen = false;
let wired = false;

function announce(): void {
  for (const cb of listeners) cb();
}

function wire(): void {
  if (wired) return;
  wired = true;
  subscribeLifecycle((event) => {
    const next = event === 'open';
    if (next === socketOpen) return;
    socketOpen = next;
    announce();
  });
}

/** The history of this session came from the local copy: the fetch failed. */
export function markHistoryFromCache(sessionKey: string): void {
  if (fromCache.has(sessionKey)) return;
  fromCache.add(sessionKey);
  announce();
}

/** A fetch answered: this session is on the server's rows again. */
export function clearHistoryFromCache(sessionKey: string): void {
  if (!fromCache.delete(sessionKey)) return;
  announce();
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * Should this chat say it is showing the local copy? Flag AND socket, see the
 * header. The server snapshot is `false`: there is no failed fetch to report on
 * a page that has not fetched anything yet.
 */
export function useServedFromCache(sessionKey: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => socketOpen && fromCache.has(sessionKey),
    () => false,
  );
}

/** Test seam: the raw flag, without the socket gate. */
export const _isFromCacheForTests = (sessionKey: string): boolean => fromCache.has(sessionKey);

/** Test seam: move the socket the way `useWebSocket` would. */
export function _setSocketOpenForTests(open: boolean): void {
  if (open === socketOpen) return;
  socketOpen = open;
  announce();
}

/** Test seam: nothing stale, socket shut, no listener left behind. */
export function _resetForTests(): void {
  fromCache.clear();
  listeners.clear();
  socketOpen = false;
}
