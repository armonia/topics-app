/**
 * WHAT THE LAST SLOT OF A TAB SHOWS, AT REST AND UNDER THE POINTER.
 *
 * A tab has three zones (TABSLOT-01): the lead icon, the label, and one 20px
 * slot at the end that is always reserved. Every state a tab can be in used to
 * sit in flow between the label and the edge, so each one that appeared, or
 * whose text changed ("5m" becoming "12m"), squeezed and moved the label. Now
 * there is one place for state, and it can hold one thing at a time: this
 * module decides which.
 *
 * Two questions, two functions, both pure so the precedence is testable without
 * mounting a tab bar:
 *  · the SIGNAL at rest (TABSLOT-02): freeze > working > attention > nothing,
 *    with working and attention together drawn as the ring around the number;
 *  · the COMMAND the slot becomes on hover or keyboard focus (CHROME-12): stop
 *    while a turn can be stopped, close otherwise, never both side by side.
 */

export type TabSlotSignal =
  /** Topics has paused this session's command to save memory. */
  | { kind: 'freeze' }
  /** Something is running. `count` > 0 draws the ring around the number. */
  | { kind: 'working'; count: number }
  /** Something asks for you and nothing runs. */
  | { kind: 'attention'; count: number }
  | { kind: 'none' };

export function tabSlotSignal({ frozen, working, attention }: {
  frozen: boolean;
  working: boolean;
  /** How many things ask for you (unread, awaiting, cards in review). */
  attention: number;
}): TabSlotSignal {
  // A frozen command is not working, and a ring over it would say it is.
  if (frozen) return { kind: 'freeze' };
  const count = Math.max(0, attention);
  if (working) return { kind: 'working', count };
  if (count > 0) return { kind: 'attention', count };
  return { kind: 'none' };
}

export type TabSlotCommand = 'stop' | 'close';

/**
 * The one command the slot turns into. Stop first, because closing a surface
 * whose turn is still alive is the second half of the same thought: once the
 * turn has stopped, the same slot offers close. A project tab never offers
 * stop, since next to the close button it would stop every agent inside it.
 */
export function tabSlotCommand({ canStop, closable, isProject }: {
  /** A turn is running here AND the host wired the composer's stop. */
  canStop: boolean;
  /** The host lets this tab close (derived task-drawer panes do not). */
  closable: boolean;
  isProject: boolean;
}): TabSlotCommand | null {
  if (canStop && !isProject) return 'stop';
  return closable ? 'close' : null;
}
