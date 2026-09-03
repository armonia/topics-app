import { useEffect, useRef, useState } from 'react';
import { computeAutoShared, stepAutoShare, type AutoShareState } from '../lib/sharedAuto';
import { startViewerCountFeed } from './viewerCountFeed';

/**
 * Decide, reading by reading, whether a desktop browser pane should render its
 * private native WKWebView or join the shared server session.
 *
 * The input is the viewer count of the context: how many devices are watching
 * it. A Tauri pane on the native path opens NO streaming WS, so the count is
 * exactly the number of OTHER devices (phone PWA / web) watching, the trigger
 * to auto-join. The arithmetic of that reading is `computeAutoShared`; how
 * many readings it takes to move the pane is `stepAutoShare`.
 *
 * WHERE THE READINGS COME FROM is `viewerCountFeed`: the server pushes the
 * count on the browser socket when it changes, each push is followed by one
 * confirming fetch, and a 30s poll stands in only while no socket is up. It
 * used to be a 2s poll per pane, which was 44% of all API requests on the
 * live server for a value that moves a few times an hour.
 *
 * THE FOLD LIVES HERE, NOT IN THE CALLER, for two reasons and both are load
 * bearing:
 *
 *  - A caller can only see the count when it CHANGES: `setCount` with the same
 *    number bails out of the render, so an effect keyed on the count never runs
 *    twice in a row on a steady reading. Counting agreements out there would
 *    mean a pane that reaches one confirmation and waits forever for a second
 *    that cannot arrive.
 *  - Folding here also keeps the re-render where it belongs: only a real FLIP
 *    reaches React.
 *
 * Reads only while `enabled`; disabled means no traffic and a decision of
 * false. Network errors take no reading: a blip must not feed the fold a
 * number the server never sent.
 *
 * @param isVisible is this pane on screen, i.e. inside the server's count? A
 *   hidden shared pane reports `set_watching:false` and drops out, so it must
 *   not subtract itself (see `computeAutoShared`).
 */
export function useSharedViewerCount(contextId: string, enabled: boolean, isVisible = true): boolean {
  /** The decision, carrying the context it was made for: a pane reused for a
   *  different id must not answer with the previous one's side. Reset during
   *  render on the prop change (the pattern already used in RemoteBrowserPanel),
   *  not from inside the effect, where a synchronous setState would be a second
   *  render nobody asked for. */
  const [decided, setDecided] = useState<{ ctx: string; shared: boolean }>({ ctx: contextId, shared: false });
  if (decided.ctx !== contextId) setDecided({ ctx: contextId, shared: false });
  /** The fold's state between readings. A ref, so a steady reading costs no render. */
  const decision = useRef<AutoShareState>({ shared: false, agreeing: 0 });
  /** Read inside the reading closure, so `isVisible` changes need no re-subscribe.
   *  Written in an effect and not during render: a ref assigned while rendering
   *  is a value the next render may or may not have, which is exactly the kind
   *  of "sometimes" this hook exists to remove. */
  const visibleRef = useRef(isVisible);
  useEffect(() => { visibleRef.current = isVisible; }, [isVisible]);

  useEffect(() => {
    decision.current = { shared: false, agreeing: 0 };
    if (!enabled) return; // no readings: the pane stays on its native path

    const fold = (count: number) => {
      const prev = decision.current;
      const next = stepAutoShare(prev, computeAutoShared(count, prev.shared, visibleRef.current));
      decision.current = next;
      if (next.shared !== prev.shared) setDecided({ ctx: contextId, shared: next.shared });
    };

    const feed = startViewerCountFeed({
      contextId,
      fetchCount: async () => {
        const res = await fetch(`/api/browsers/${encodeURIComponent(contextId)}/viewers`);
        if (!res.ok) return null;
        const data = await res.json();
        return typeof data?.count === 'number' ? data.count : null;
      },
      onReading: fold,
    });

    return () => feed.stop();
  }, [contextId, enabled]);

  return enabled && decided.ctx === contextId ? decided.shared : false;
}
