/**
 * YOUR FRIENDS, TURNED INTO ROWS THE BAND ALREADY KNOWS HOW TO DRAW.
 *
 * The third subject at the bottom of the sidebar used to be fed by the
 * ORGANISATION ADDRESS BOOK: everybody who shares a group with you, a list
 * nobody chose, that fills up the day you join a group and empties the day you
 * leave it. It was labelled "People", which was honest about the data and
 * useless as an answer: the question a person asks that corner of the screen is
 * "who do I know, and who is around right now", and the app has had a real
 * friendship graph since the friendships routes landed.
 *
 * So the subject now reads the graph, and this module is the join between the
 * two shapes: a friend carries `lastSeenAt` on their own record (the address
 * book route already publishes it, subject to that person's privacy), so
 * presence needs no second round trip to the members route.
 *
 * THE THRESHOLD IS THE SAME ONE, on purpose: `PRESENZA_MS` lives in
 * `orgPresence` and is imported rather than re-declared, because two windows of
 * "recently seen" would let the group chip and the friends chip disagree about
 * the same person on the same screen.
 *
 * PRESENT FIRST, then most recently seen, then the name: the order the org
 * panel already uses, so the faces on the chip are the first rows of the panel
 * in both subjects.
 */
import type { FriendPerson } from '@/lib/api';
import { PRESENZA_MS, type PresenceFace, type PresenceRow } from './orgPresence';

/** One or two initials. Empty when there is no name: the drawing side decides
 *  what to put in their place. */
function initialOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

/**
 * A `lastSeenAt` in the FUTURE (two machines whose clocks disagree) counts as
 * present: that is the right direction to be wrong in, because the opposite
 * mistake hides somebody who is actually there.
 *
 * A friend who publishes no presence has `lastSeenAt` null and is drawn as
 * absent, which is the only thing that can be said without inventing one.
 */
function isPresent(seen: number | null, now: number, windowMs: number): boolean {
  return seen !== null && Number.isFinite(seen) && now - seen < windowMs;
}

/** Every friend, present first: the list behind the friends dropdown. */
export function friendRows(
  friends: readonly FriendPerson[],
  now: number,
  windowMs: number = PRESENZA_MS,
): PresenceRow[] {
  return friends
    .map((p) => {
      const name = (p.displayName || '').trim();
      return {
        id: p.id,
        nome: name,
        avatarUrl: p.github?.avatarUrl ?? null,
        iniziali: initialOf(name),
        presente: isPresent(p.lastSeenAt, now, windowMs),
        vistoA: p.lastSeenAt,
      };
    })
    .sort((a, b) => Number(b.presente) - Number(a.presente)
      || (b.vistoA ?? 0) - (a.vistoA ?? 0)
      || a.nome.localeCompare(b.nome));
}

/** The faces for the closed chip: only who is online, in the same order the
 *  panel puts them in. */
export function friendFaces(rows: readonly PresenceRow[]): PresenceFace[] {
  return rows
    .filter((r) => r.presente)
    .map(({ id, nome, avatarUrl, iniziali }) => ({ id, nome, avatarUrl, iniziali }));
}
