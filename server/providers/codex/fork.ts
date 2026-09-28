/**
 * A forked Codex chat (CODEX-02, CHAT-FORK-01): the point the route records at
 * the click, and the fork a branch's first turn can still take.
 *
 * The point is the byte size of the parent's rollout. Codex has no
 * `--resume-session-at`: `codex exec fork` copies the parent thread as it is
 * when the branch's first turn runs, so the fork is valid only while the
 * rollout still has the size it had at the click. A parent that moved on
 * would carry into the branch turns its chat does not show.
 */
import { statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { codexRolloutPath } from "../../lib/codex-session";
import { readForkOrigin } from "../../lib/chat-fork-store";

function rolloutSize(threadId: string): number | null {
  const path = codexRolloutPath(threadId);
  if (!path) return null;
  try { return statSync(path).size; } catch { return null; }
}

/** Where a fork of this Codex chat starts: its thread and its rollout's size now. */
export function codexForkPoint(db: Database, sessionKey: string): { ref: string; at: string } | null {
  const row = db.prepare(`SELECT codex_thread_id FROM codex_sessions WHERE session_key = ?`).get(sessionKey) as { codex_thread_id: string } | null;
  const size = row ? rolloutSize(row.codex_thread_id) : null;
  return row && size !== null ? { ref: row.codex_thread_id, at: String(size) } : null;
}

/** The fork a branch's turn could take, for `resolveCodexInvocation`; null when none is pending. */
export function codexForkOf(db: Database, sessionKey: string): { parentThreadId: string; parentRolloutExists: boolean; parentUnchanged: boolean } | null {
  const origin = readForkOrigin(db, sessionKey);
  if (origin?.runtime !== "codex-cli" || !origin.parentRef) return null;
  const size = rolloutSize(origin.parentRef);
  return { parentThreadId: origin.parentRef, parentRolloutExists: size !== null, parentUnchanged: size !== null && String(size) === origin.parentAt };
}
