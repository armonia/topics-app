/**
 * WHICH LINES OF A BROKER STORE ARE A ROW'S OWN TURN (card 98ce88d1, second
 * review of PR #145).
 *
 * A turn that ended while the server was away is replayed into its row at the
 * reattach. The first fix dated the store's last turn against the person's
 * message: that told when a turn began, not whose it was. Three stores broke it:
 *   - the row's turn ends, then its background command wakes the CLI in a turn
 *     of its own: the row closed with the woken turn's text (in 30 days, 87 of
 *     1724 closed turns had a woken turn within 20 s of their end);
 *   - a background Agent keeps printing after the turn's `result`: the store no
 *     longer ended on it, and the row stayed empty;
 *   - the turn ended between the boot's probe and the adoption.
 *
 * So the daemon marks the store (protocol 3 of server/ai-bridge.mjs): when it
 * writes a message to the CLI's stdin it first appends
 * `{"type":"topics_delivered","mark":<row id>}`, at a line boundary. A row's
 * turn runs from its mark to the first `result` after it, the one that closes
 * it live too: a leftover task notification's own empty result is skipped, as
 * `handleStreamEvent` skips it. Nothing after that result is the row's, and a
 * turn with no mark before it (a wake) never enters a person's row.
 *
 * A store without the row's mark keeps main's behaviour: the row is closed with
 * what it has. The daemon that holds production's CLIs speaks an older protocol
 * and outlives every server restart, and an empty row is better than another
 * turn's text in a person's row.
 */

export const DELIVERY_MARK = "topics_delivered";

/** Where one row's turn lies in the store: just past its mark, and just past its `result` once that came. */
export interface RowTurn {
  from: number;
  end?: number;
}

export interface RowTurns {
  byRow: Map<string, RowTurn>;
  /** A task notification came after the last mark: the next empty zero-turn result is its own turn's. */
  notified: boolean;
}

type StoreLine = { type?: unknown; subtype?: unknown; mark?: unknown; result?: unknown; num_turns?: unknown; is_error?: unknown } | null;

export function isDeliveryMark(event: unknown): boolean {
  return (event as StoreLine)?.type === DELIVERY_MARK;
}

/** The end of a task notification's own turn: a clean success with no model turn and no text. */
export function isNotificationTurnEnd(event: unknown): boolean {
  const e = event as StoreLine;
  return (typeof e?.result !== "string" || e.result === "") && e?.num_turns === 0 && e.subtype === "success" && e.is_error !== true;
}

/** One store line the scan folded, ending at byte `end`. */
export function foldRowTurns(t: RowTurns | undefined, event: unknown, end: number): RowTurns | undefined {
  const e = event as StoreLine;
  if (e?.type === DELIVERY_MARK && typeof e.mark === "string") {
    const turns = t ?? { byRow: new Map<string, RowTurn>(), notified: false };
    turns.byRow.set(e.mark, { from: end });
    turns.notified = false;
    return turns;
  }
  if (!t || !e) return t;
  if (e.type === "system" && e.subtype === "task_notification") t.notified = true;
  else if (e.type === "system" && e.subtype === "compact_boundary") t.notified = false;
  else if (e.type === "result" && e.result !== "waiting for message") {
    const notificationOwn = t.notified && isNotificationTurnEnd(e);
    t.notified = false;
    if (!notificationOwn) for (const turn of t.byRow.values()) turn.end ??= end;
  }
  return t;
}

/** The turn the row's own message started, if the store has its mark. */
export function rowTurn(t: RowTurns | undefined, rowId: string | undefined): RowTurn | undefined {
  return rowId ? t?.byRow.get(rowId) : undefined;
}
