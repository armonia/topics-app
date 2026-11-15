import type { Database } from "bun:sqlite";
import { warnThrottled } from "./warn-throttled";

/**
 * One line from the terminal bridge. A line that does not parse is dropped (the
 * caller already counted it as proof of life); a handler that throws is
 * reported, because it leaves the terminal state stale.
 */
export function dispatchBridgeLine(line: string, handle: (msg: unknown) => void): void {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return; }
  try {
    handle(parsed);
  } catch (e) {
    warnThrottled("terminal:bridge-handler", "[Terminal] bridge message handler threw, terminal state may be stale:", e);
  }
}

/**
 * Parks (resumable) or deletes the `terminal_sessions` row of a session that
 * exited. A failure leaves a ghost row that revives on reload: it is reported.
 */
export function settleExitedSessionRow(
  getDb: () => Database,
  row: { id: string; resumable: boolean; exitCode: number | null },
): void {
  try {
    const db = getDb();
    if (row.resumable) {
      db.run("UPDATE terminal_sessions SET status = 'dormant', exit_code = ? WHERE id = ?", [row.exitCode, row.id]);
    } else {
      db.run("DELETE FROM terminal_sessions WHERE id = ?", [row.id]);
    }
  } catch (e) {
    warnThrottled(`terminal_sessions:exit-row:${row.id}`, `[Terminal] terminal_sessions: parking or deleting the row of exited session ${row.id} failed, it may revive on reload:`, e);
  }
}

/** Kills every child; a kill that throws leaves that child alive without an owner, so it is reported. */
export function killChildren(
  children: readonly { id: string }[],
  parentSessionKey: string,
  kill: (childId: string) => void,
): void {
  for (const child of children) {
    try { kill(child.id); } catch (e) {
      warnThrottled(`terminal:cascade-kill:${child.id}`, `[Terminal] killing child ${child.id} of ${parentSessionKey} failed, it may stay alive without an owner:`, e);
    }
  }
}
