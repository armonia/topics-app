/**
 * streamingHydration — server-truth set of topics whose last message is still
 * being written (DB `partial` flag), so "this session is mid-reply" survives a
 * page reload.
 *
 * Why this exists: useChat's `streaming` map is populated ONLY by live
 * `stream:start` WS events, so it's empty for sessions that were already
 * replying when the page loaded — their tabs/rows showed no spinner even
 * though the Master strip (which reads the DB `partial` flag) did. This store
 * fetches the same authoritative state (`/api/topics/master/sessions`,
 * state === 'streaming') and StreamingContext unions it into the live map, so
 * every consumer (sidebar topic row, chat tab, project row) lights up for
 * already-active sessions too.
 *
 * Kept fresh by refetching on stream start/end WS events plus a slow interval
 * safety net. Live transitions during the session are still driven by useChat;
 * this just seeds + corrects the at-load baseline.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { WSMessage } from '../types';

interface StreamingHydrationStore {
  /** Topic ids whose last message is partial (server says 'streaming'). */
  topicIds: Set<string>;
  setTopicIds: (ids: Set<string>) => void;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export const useStreamingHydrationStore = create<StreamingHydrationStore>((set) => ({
  topicIds: new Set(),
  setTopicIds: (ids) =>
    set((state) => (setsEqual(ids, state.topicIds) ? state : { topicIds: ids })),
}));

interface MasterSessionRow {
  topicId: string;
  state: string;
}

/**
 * Mount once (App level). Fetches the server's per-session state and mirrors
 * the streaming topics into the store; refetches on stream lifecycle WS events
 * and on a slow interval.
 */
export function useStreamingHydration(
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void,
) {
  const setTopicIds = useStreamingHydrationStore((s) => s.setTopicIds);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const res = await fetch('/api/topics/master/sessions');
        if (!res.ok) return;
        const body = (await res.json()) as { sessions?: MasterSessionRow[] };
        if (cancelled) return;
        const next = new Set<string>();
        for (const s of body.sessions ?? []) {
          if (s.state === 'streaming' && s.topicId) next.add(s.topicId);
        }
        setTopicIds(next);
      } catch {
        /* best-effort — live WS still drives in-session transitions */
      }
    };

    refresh();
    const interval = setInterval(refresh, 15_000);

    // A stream starting/ending flips a message's partial flag — refetch so the
    // hydrated baseline tracks it (debounced via a microtask coalesce).
    let pending = false;
    const debouncedRefresh = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; refresh(); }, 400);
    };
    const unsub = onWSMessage((msg) => {
      if (msg.type === 'stream:start' || msg.type === 'stream:end') debouncedRefresh();
    });

    return () => { cancelled = true; clearInterval(interval); unsub(); };
  }, [onWSMessage, setTopicIds]);
}
