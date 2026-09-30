/**
 * WHICH ROWS PLAY THE ENTRANCE: the ones that ARRIVED while the list was on
 * screen, and nothing else.
 *
 * `message-appear` (a 200 ms slide and fade) is the sign that a message just
 * came in. It used to sit on every row, and a virtual list mounts rows all the
 * time without anything arriving: a chat opened again after a tab switch, the
 * list rebuilt beside a new split, the phone keyboard closing. Measured in the
 * UI audit of 2026-09-29 (panes:F3): 13 history bubbles replayed the entrance
 * on a phone chat switch, 9 on the return to a chat already loaded, 10 when a
 * browser pane opened beside a chat, 3 when the keyboard closed. It looked like
 * the conversation blinking in again, on the most repeated gesture of the app.
 *
 * The rule: every id the list holds before it has settled (the history, the
 * local copy, whatever the opening brought) is KNOWN and never animates. An id
 * seen for the first time after the list settled is an arrival, and its row
 * animates if it mounts within `ENTRANCE_WINDOW_MS` of that moment. A row
 * Virtuoso mounts again later, scrolling back to it, is history by then.
 *
 * One tracker per mounted list; a change of topic starts it over, as a fresh
 * opening.
 */
export const ENTRANCE_WINDOW_MS = 1000;

export class MessageEntrance {
  private topicId: string | null = null;
  private readonly known = new Set<string>();
  private readonly arrivedAt = new Map<string, number>();

  /**
   * Record the ids the list holds now. Idempotent, so it can run during render
   * (StrictMode renders twice). `settled` is whether the list had settled on
   * screen BEFORE this render: a row that is already in the first settled
   * frame is history, not an arrival.
   */
  note(topicId: string, ids: Iterable<string>, settled: boolean, now: number): void {
    if (topicId !== this.topicId) {
      this.topicId = topicId;
      this.known.clear();
      this.arrivedAt.clear();
      // The first render of a new topic can still carry the old `settled`.
      settled = false;
    }
    for (const id of ids) {
      if (this.known.has(id)) continue;
      this.known.add(id);
      if (settled) this.arrivedAt.set(id, now);
    }
  }

  /** Whether the row of `id`, mounting at `now`, is a message that just came in. */
  isEntering(id: string, now: number): boolean {
    const at = this.arrivedAt.get(id);
    return at !== undefined && now - at < ENTRANCE_WINDOW_MS;
  }
}
