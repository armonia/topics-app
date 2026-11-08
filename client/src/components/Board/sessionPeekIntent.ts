/**
 * WHEN A CARD'S PEEK OPENS: once the pointer has rested on a card that has a
 * session, not at the instant it comes in.
 *
 * The rest used to be decided at `mouseenter` alone, from what the card knew at
 * that instant. A card that gets its session while the pointer is already over
 * it (the dispatcher binds the topic about a tenth of a second after the card
 * moves to "in progress", and the board hears of it a few hundred ms later)
 * saw a `mouseenter` with no session, armed nothing, and never heard of the
 * pointer again: `mouseenter` fires once, so the peek stayed shut until the
 * person left and came back. The e2e of D5e hovers the moment the API says
 * "working" and hit that window on every slow runner.
 *
 * So the pointer's presence is remembered, and a session that arrives under it
 * starts the same rest.
 */

/** How long the pointer rests on the card before the peek asks the session. */
export const SESSION_PEEK_REST_MS = 400;

export interface SessionPeekIntent {
  /** The pointer came in; `hasSession` is what the card knew at that instant. */
  enter(hasSession: boolean): void;
  /** The pointer went out. */
  leave(): void;
  /** The card gained or lost its session; it matters only while the pointer is inside. */
  sessionChanged(hasSession: boolean): void;
  /** Stop waiting without forgetting where the pointer is (a menu or a key closed the peek). */
  cancel(): void;
}

export function createSessionPeekIntent(open: () => void, restMs = SESSION_PEEK_REST_MS): SessionPeekIntent {
  let inside = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    cancel();
    timer = setTimeout(() => { timer = null; open(); }, restMs);
  };
  return {
    enter(hasSession) {
      inside = true;
      if (hasSession) arm();
    },
    leave() {
      inside = false;
      cancel();
    },
    sessionChanged(hasSession) {
      if (!inside) return;
      if (hasSession) arm(); else cancel();
    },
    cancel,
  };
}
