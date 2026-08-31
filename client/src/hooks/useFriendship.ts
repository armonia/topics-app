/**
 * MY FRIENDS AND THE TWO INBOXES, on one timer.
 *
 * Three lists that are always read together, because they are three answers to
 * the same question and a screen shows them next to each other. Fetching them
 * from three places would be three round trips and, worse, three instants: the
 * friends count would disagree with the requests underneath it, and neither of
 * the two would be wrong. The server returns all three from a single read for
 * the same reason.
 *
 * HOW OFTEN. One minute, the rhythm `useIdentityPresence` already uses. A
 * friend request is not a keystroke: nobody is waiting on the second, and
 * polling faster would multiply a query per open window to change nothing on
 * almost every tick. A HIDDEN WINDOW ASKS FOR NOTHING, the same rule
 * `useIdentityPresence`, `usePresenceSummary` and `useSystemStatus` follow: a
 * background tab that keeps polling is a tab that costs what a foreground one
 * costs and shows it to nobody.
 *
 * A MUTATION REFRESHES IMMEDIATELY, and that is the one exception to the timer.
 * Accepting a request has to empty the inbox now, not in fifty seconds, or the
 * row stays under a finger that already pressed it. The gesture still answers
 * with the new state on its own so the caller can be optimistic without waiting
 * for the lists at all.
 *
 * WHAT IT DOES NOT DO. It draws nothing and knows about no screen. A refused
 * gesture throws `ApiError` up to the caller rather than being swallowed here:
 * the 409 that says "you cannot ask again" is the only thing distinguishing a
 * refusal from a request still pending, and a hook that ate it would make that
 * distinction unavailable to every screen at once.
 */
import { useCallback, useEffect, useState } from 'react';
import { friendsApi, type FriendPerson, type FriendshipState } from '@/lib/api';

/** Every minute, like the identity row: see the header for why not faster. */
const INTERVAL_MS = 60_000;

interface Lists {
  friends: FriendPerson[];
  incoming: FriendPerson[];
  outgoing: FriendPerson[];
  /** `false` until the first round trip is back, so a list does not flash
   *  "no friends" on the way to showing some. */
  pronto: boolean;
}

export interface Friendship extends Lists {
  /** Read the three lists now. */
  reload: () => Promise<void>;
  /** Ask. If they had already asked me this accepts instead, so the caller
   *  must draw whatever state comes back and not the one it expected. */
  request: (id: string) => Promise<FriendshipState>;
  accept: (id: string) => Promise<FriendshipState>;
  decline: (id: string) => Promise<FriendshipState>;
  /** Withdraw my request, or end a friendship. */
  cancel: (id: string) => Promise<FriendshipState>;
}

const EMPTY: Lists = { friends: [], incoming: [], outgoing: [], pronto: false };

export function useFriendship(enabled = true, intervalMs = INTERVAL_MS): Friendship {
  const [liste, setListe] = useState<Lists>(EMPTY);

  /**
   * `forzato` is what a mutation passes: the window is visible by definition
   * when somebody has just pressed something, but the guard lives at the top of
   * this function and a mutation must never be the one call that silently does
   * nothing because a tab lost focus mid-gesture.
   */
  const read = useCallback(async (forzato = false) => {
    if (!forzato && document.hidden) return;
    try {
      const r = await friendsApi.list();
      setListe({ friends: r.friends, incoming: r.incoming, outgoing: r.outgoing, pronto: true });
    } catch {
      // An installation with no accounts service answers nothing here. We keep
      // the lists we have rather than emptying them: "I could not ask" is not
      // the same fact as "you have no friends", and only one of the two is
      // worth redrawing a screen for.
      setListe((p) => (p.pronto ? p : { ...p, pronto: true }));
    }
  }, []);

  const reload = useCallback(() => read(true), [read]);

  /**
   * The lists are refreshed but NOT awaited: the caller already holds the new
   * state and can draw it in this frame. Waiting for three lists to come back
   * before resolving would put a round trip behind every button for a value
   * the first response already carried.
   */
  const action = useCallback(
    async (azione: (id: string) => Promise<{ state: FriendshipState }>, id: string) => {
      const { state } = await azione(id);
      void read(true);
      return state;
    },
    [read],
  );

  const request = useCallback((id: string) => action(friendsApi.request, id), [action]);
  const accept = useCallback((id: string) => action(friendsApi.accept, id), [action]);
  const decline = useCallback((id: string) => action(friendsApi.decline, id), [action]);
  const cancel = useCallback((id: string) => action(friendsApi.cancel, id), [action]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const giro = () => { if (alive) void read(); };
    // After the first paint and not during it: none of these rows is needed in
    // the first frame, and a synchronous state write on mount is exactly what
    // `set-state-in-effect` flags.
    const first = setTimeout(giro, 0);
    const each = setInterval(giro, intervalMs);
    // Coming back to the window is the moment somebody wants to know whether
    // anything arrived while they were away, and it is also the tick the hidden
    // guard above has been skipping.
    const onSettled = () => { if (!document.hidden) giro(); };
    document.addEventListener('visibilitychange', onSettled);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(each);
      document.removeEventListener('visibilitychange', onSettled);
    };
  }, [enabled, intervalMs, read]);

  return { ...liste, reload, request, accept, decline, cancel };
}
