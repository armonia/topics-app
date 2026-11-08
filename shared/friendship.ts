/**
 * THE FIVE STATES OF A FRIENDSHIP, as ONE person sees them.
 *
 * Declared here and not once per side, for the reason `shared/profile.ts`
 * already gives: `tests/unit/no-type-mirrors.test.ts` forbids the alternative,
 * because a hand-copied type carries a "keep in sync" comment and then does
 * not. Both sides re-export from this file.
 *
 * WHY THE STATE IS RELATIVE TO THE VIEWER. A friendship is one row shared by
 * two people, but it is never the same thing to both of them: the one who
 * asked is waiting, the one who was asked has something to answer. A single
 * absolute state ('pending') would force every screen to also work out which
 * end of the row it is standing on, and one of those screens would get it
 * wrong and offer an Accept button to the person who sent the request. So the
 * wire carries the state ALREADY resolved for whoever asked for it.
 *
 * The follow graph in `shared/profile.ts` is a DIFFERENT relation and stays
 * exactly as it is. A follow is "I read you" and needs no answer; a friendship
 * is "we know each other" and is the only one of the two that is asked for.
 */

/**
 * Where I stand with one other person.
 *
 * `declined_out` is the asymmetric one, and deliberately so: it exists only on
 * the side of the person who ASKED. From the side of the person who refused
 * the state is `none`, which is not a lie by omission but the rule itself. A
 * refusal closes the door for the person who knocked and leaves it usable by
 * the person who closed it, so "they refused me" and "I refused them" are not
 * two symmetric facts and must not be two symmetric names.
 *
 * The client is expected to draw `declined_out` and `pending_out` the same
 * way, so the refusal is not announced to the person who was refused. The
 * server still has to tell them apart: one of the two lets you ask again.
 */
export type FriendshipState = 'none' | 'pending_out' | 'pending_in' | 'friends' | 'declined_out';

/**
 * One relation, from the point of view of whoever asked for it.
 *
 * `since` is when the state it carries began, in milliseconds: the moment the
 * request was sent for the two pending states, the moment it was answered for
 * `friends` and `declined_out`. One field and not two, because a screen shows
 * one date per row and having both would make every caller choose.
 */
export interface FriendshipEdge {
  personId: string;
  state: FriendshipState;
  since: number;
}
