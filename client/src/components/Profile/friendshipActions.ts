import type { FriendshipState } from '@/lib/api';

/**
 * WHAT THE BUTTON SAYS, for each of the five states.
 *
 * This is a pure map and it lives in its own file for one reason: it is the
 * only place where the rule "a refusal is not announced to the person who was
 * refused" can be checked by a test. Inside the component that rule would be a
 * branch among the spinners and the optimistic updates, and the day somebody
 * added a "they said no" label to `declined_out` nothing would have failed.
 *
 * `declined_out` and `pending_out` MUST produce exactly the same buttons. The
 * server tells them apart because one of the two lets you ask again; the screen
 * must not, because the person reading it is the one who knocked. The unit test
 * next door compares the two outputs field by field.
 */

/** The four gestures, named after the call each one makes. */
export type FriendshipAction = 'request' | 'accept' | 'decline' | 'cancel';

export interface FriendshipButton {
  action: FriendshipAction;
  /** i18n key for the label. */
  labelKey: string;
  /** `primary` is the one thing to do; `quiet` is the way back out. */
  tone: 'primary' | 'quiet';
  testId: string;
}

const REQUEST: FriendshipButton = {
  action: 'request', labelKey: 'profile.friend.add', tone: 'primary', testId: 'friend-add',
};
/** Sent, and not answered yet. Pressing it withdraws the request. */
const SENT: FriendshipButton = {
  action: 'cancel', labelKey: 'profile.friend.sent', tone: 'quiet', testId: 'friend-sent',
};

export function friendshipButtons(state: FriendshipState): FriendshipButton[] {
  switch (state) {
    case 'none':
      return [REQUEST];
    // The two that must look identical. Written as one branch on purpose: two
    // branches returning equal literals is an invitation to edit only one.
    case 'pending_out':
    case 'declined_out':
      return [SENT];
    case 'pending_in':
      return [
        { action: 'accept', labelKey: 'profile.friend.accept', tone: 'primary', testId: 'friend-accept' },
        { action: 'decline', labelKey: 'profile.friend.decline', tone: 'quiet', testId: 'friend-decline' },
      ];
    case 'friends':
      return [
        { action: 'cancel', labelKey: 'profile.friend.remove', tone: 'quiet', testId: 'friend-remove' },
      ];
  }
}

/**
 * The line above the buttons, or nothing. Only two states have something to
 * say that the button does not already say: one is waiting on the other
 * person, the other is waiting on YOU and is the only one that is a request.
 */
export function friendshipNoteKey(state: FriendshipState): string | null {
  if (state === 'pending_in') return 'profile.friend.wantsToBeFriends';
  if (state === 'friends') return 'profile.friend.areFriends';
  return null;
}
