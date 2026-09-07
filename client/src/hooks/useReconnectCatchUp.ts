import { useEffect } from 'react';
import type { RefObject } from 'react';
import { subscribeReconnect } from '../lib/wsFrameBus';

/**
 * The catch-up a client owes itself after the WS socket has been REPLACED.
 *
 * The server does not replay finished turns to a socket that just opened
 * (`server.ts` only sends the live state), so everything that happened while
 * the client was disconnected exists solely on disk: the open chats have to
 * ask for it. The outbound queue is in the same position — a message typed
 * while the socket was down sits there until somebody drains it.
 *
 * WHY NOT THE CONNECTION STATUS. This used to hang off the
 * `!== 'connected'` to `'connected'` edge of the status the WS hook exposes,
 * and that status is deliberately smoothed: it keeps saying `connected` for
 * three seconds so the status bar does not blink on a hiccup. The reconnect
 * backoff starts at ONE second, and a wake probe reconnects even faster, so
 * the usual reconnection never produced an edge at all: no drain, no history,
 * a chat that stayed frozen on the last turn it saw until the page reloaded.
 *
 * The socket itself has no such smoothing: `subscribeReconnect` fires inside
 * `ws.onopen`, and only for the RE-opens, so the cold start (already served by
 * the mount effects of the chat pane and of the topic list) is not doubled.
 */
export function useReconnectCatchUp(args: {
  /** Flush the messages typed while the socket was down. */
  drainQueue: () => void;
  /** Refresh the topic list (titles, unread, new topics). */
  loadTopics: () => Promise<unknown> | unknown;
  /** Re-fetch one session's history, by session key. */
  loadHistory: (sessionKey: string) => Promise<unknown> | unknown;
  /** Panes open in this window, mirrored so the subscription stays stable. */
  openPanelsRef: RefObject<string[]>;
  /** Topic map, mirrored for the same reason. */
  topicsRef: RefObject<Record<string, { sessionKey: string }>>;
}): void {
  const { drainQueue, loadTopics, loadHistory, openPanelsRef, topicsRef } = args;
  useEffect(() => subscribeReconnect(() => {
    drainQueue();
    void loadTopics();
    for (const panelId of openPanelsRef.current ?? []) {
      const topic = topicsRef.current?.[panelId];
      if (topic) void loadHistory(topic.sessionKey);
    }
  }), [drainQueue, loadTopics, loadHistory, openPanelsRef, topicsRef]);
}
