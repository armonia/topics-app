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
 *
 * A WAKE'S ROW has no stdin write to mark: the CLI starts that turn by itself.
 * Its adopter marks it instead, through the same `write` with no data, as
 * `<row id>@<offset>`: the offset where the wake's first line starts, which
 * the mark itself lands after. That turn runs from there to the first `result`
 * after it, which may already be in the store when the mark arrives (a short
 * wake is over before the route has opened its row). Without it, two wakes
 * across a restart put the second's text in the first's row, and a wake that
 * ended while the server was away left its row «no reply».
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
  /** Where every turn-closing `result` ends, in order: a wake's mark comes after its turn has begun. */
  results: number[];
}

type StoreLine = { type?: unknown; subtype?: unknown; mark?: unknown; result?: unknown; num_turns?: unknown; is_error?: unknown } | null;

export function isDeliveryMark(event: unknown): boolean {
  return (event as StoreLine)?.type === DELIVERY_MARK;
}

/** A wake's mark, left by its adopter: it opens no turn, the one it names had begun already. */
export function isWakeMark(event: unknown): boolean {
  const mark = (event as StoreLine)?.mark;
  return isDeliveryMark(event) && typeof mark === "string" && mark.includes("@");
}

/** The mark a wake's adopter leaves for `rowId`, whose turn starts at byte `at` of the store. */
export function wakeMark(rowId: string, at: number): string {
  return `${rowId}@${at}`;
}

/** The end of a task notification's own turn: a clean success with no model turn and no text. */
export function isNotificationTurnEnd(event: unknown): boolean {
  const e = event as StoreLine;
  return (typeof e?.result !== "string" || e.result === "") && e?.num_turns === 0 && e.subtype === "success" && e.is_error !== true;
}

/** One store line the scan folded, ending at byte `end`. */
export function foldRowTurns(t: RowTurns | undefined, event: unknown, end: number): RowTurns | undefined {
  const e = event as StoreLine;
  const turns = () => (t ??= { byRow: new Map<string, RowTurn>(), notified: false, results: [] });
  if (e?.type === DELIVERY_MARK && typeof e.mark === "string") {
    const at = e.mark.lastIndexOf("@");
    const from = at < 0 ? NaN : Number(e.mark.slice(at + 1));
    if (Number.isInteger(from) && from >= 0) {
      turns().byRow.set(e.mark.slice(0, at), { from, end: turns().results.find((r) => r > from) });
    } else {
      turns().byRow.set(e.mark, { from: end });
      turns().notified = false;
    }
  } else if (e?.type === "system" && e.subtype === "task_notification") turns().notified = true;
  else if (e?.type === "system" && e.subtype === "compact_boundary") turns().notified = false;
  else if (e?.type === "result" && e.result !== "waiting for message") {
    const notificationOwn = turns().notified && isNotificationTurnEnd(e);
    turns().notified = false;
    if (!notificationOwn) {
      turns().results.push(end);
      for (const turn of turns().byRow.values()) turn.end ??= end;
    }
  }
  return t;
}

/** The turn the row's own message started, if the store has its mark. */
export function rowTurn(t: RowTurns | undefined, rowId: string | undefined): RowTurn | undefined {
  return rowId ? t?.byRow.get(rowId) : undefined;
}
