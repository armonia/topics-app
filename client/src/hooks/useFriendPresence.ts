/**
 * YOUR FRIENDS, ALREADY SORTED INTO "HERE NOW" AND "NOT HERE".
 *
 * `useFriendship` brings the three lists; `friendPresence` turns them into the
 * rows the sidebar band draws. What sits between the two is the CLOCK, and the
 * clock is why this is a hook and not a line inside the component: reading
 * `Date.now()` while rendering makes the result depend on when React happened
 * to re-render, which is the whole reason `react-hooks/purity` refuses it.
 *
 * SO THE CLOCK TICKS ON ITS OWN, once a minute, the same rhythm the lists use.
 * That tick is not decoration: presence expires after five minutes of silence,
 * so without it a friend who closed their laptop would keep a green dot until
 * the next fetch happened to return a different array.
 */
import { useEffect, useState } from 'react';
import { friendFaces, friendRows } from '@/components/Sidebar/friendPresence';
import type { PresenceFace, PresenceRow } from '@/components/Sidebar/orgPresence';
import { useFriendship, type Friendship } from './useFriendship';

/** The same minute `useFriendship` polls on: a finer clock would redraw the
 *  same dots, a coarser one would keep somebody green after they left. */
const TICK_MS = 60_000;

export interface FriendPresence extends Friendship {
  /** Every friend, present first: the list behind the dropdown. */
  rows: PresenceRow[];
  /** Only who is here now, in the same order: the faces on the chip. */
  faces: PresenceFace[];
}

export function useFriendPresence(): FriendPresence {
  const friendship = useFriendship();
  const { friends } = friendship;
  const [rows, setRows] = useState<PresenceRow[]>([]);

  useEffect(() => {
    const recompute = () => setRows(friendRows(friends, Date.now()));
    // After the first paint and not during it: a synchronous state write on
    // mount is exactly what `set-state-in-effect` flags, and no dot is needed
    // in the first frame.
    const first = setTimeout(recompute, 0);
    const each = setInterval(recompute, TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(each);
    };
  }, [friends]);

  return { ...friendship, rows, faces: friendFaces(rows) };
}
