/**
 * THE LAST TURN OF A BROKER STORE THAT ENDS ON A `result`, AND WHETHER IT IS
 * THE ONE THE ADOPTED ROW IS WAITING FOR (card 98ce88d1, review of PR #145).
 *
 * A turn that ended while the server was away is replayed into its row at the
 * reattach. Two ways to get it wrong, both measured:
 *   - the turn begins after the previous turn's `result`, an EMPTY one included:
 *     the first turn after a `/compact` began at the compaction's result, and a
 *     replay from the last non-empty one closed the row on that empty result;
 *   - the store's last turn may not be the row's: a SIGTERM after the message
 *     reached stdin but before the CLI's `system/init` (its UserPromptSubmit
 *     hooks run first, 3.22 s measured with a 3 s hook) leaves the PREVIOUS
 *     turn last, and replaying it copied that answer into the new row.
 *
 * The store has no clock of its own. A turn's start is known only when its
 * `result` is the store's last line: then it was written at the child's last
 * write (the daemon's `lastDataAt`, or the store file's mtime from a daemon
 * older than that field, like the one production ran on 25/09), and began
 * `duration_ms` before. Anything short of that is "not known", and the caller
 * keeps what it did before.
 */
import { statSync } from "fs";
import { join } from "path";

export interface ClosedTurn {
  /** Where the last turn begins: the end of the `result` before it, an empty one included. */
  from: number;
  /** The end of the last `result` line, of any kind. */
  end: number;
  /** That last `result` carried an answer (not a `/compact`'s or a notification's empty one). */
  answered: boolean;
  durationMs?: number;
  /** The store's end and the daemon's last write, when the scan was over. */
  storeEnd?: number;
  lastDataAt?: number;
}

/** A `result` line the scan folded, ending at `end`. */
export function foldResult(t: ClosedTurn | undefined, end: number, event: { result?: unknown; duration_ms?: unknown }): ClosedTurn {
  const answered = typeof event.result === "string" && event.result !== "";
  const durationMs = typeof event.duration_ms === "number" ? event.duration_ms : undefined;
  return { from: answered ? (t?.end ?? 0) : (t?.from ?? 0), end, answered, durationMs };
}

/** The scan is over: where the store ended, and when the child last wrote to it. */
export function sealScan(t: ClosedTurn | undefined, scan: { endOffset?: number; lastDataAt?: number }): ClosedTurn | undefined {
  return t && { ...t, storeEnd: scan.endOffset, lastDataAt: scan.lastDataAt };
}

/** Did the store's last turn begin after the message the row answers? Unknown is no. */
export function answersTheRow(t: ClosedTurn | undefined, answeredAt: number | undefined): boolean {
  if (!t?.answered || t.end !== t.storeEnd || t.lastDataAt === undefined || t.durationMs === undefined) return false;
  return typeof answeredAt === "number" && Number.isFinite(answeredAt) && t.lastDataAt - t.durationMs >= answeredAt;
}

/** When the child last wrote to its store, from the file (the name `storePathFor` gives it in ai-bridge.mjs). */
export function storeWrittenAt(storeDir: string, sessionKey: string): number | undefined {
  try { return statSync(join(storeDir, `${sessionKey.replace(/[^A-Za-z0-9_.-]/g, "_")}.ndjson`)).mtimeMs; } catch { return undefined; }
}
