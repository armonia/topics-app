/**
 * `chat_forks`: one row per forked topic, written at its birth
 * (`server/routes/fork.ts`, migration 20260928203249-chat-forks.sql).
 *
 * After the birth the only write is `parent_ref = parent_at = NULL`, the
 * fork consumed: by a Codex fork turn once its thread is known, by a Claude
 * Code fork start at its first `system/init`, and by `/clear` on the branch, on
 * every runtime (a chat emptied by the person does not take anybody's history
 * back).
 */
import type { Database } from "bun:sqlite";
import type { ForkMode } from "../../shared/chat-fork";
import type { ForkOrigin } from "./chat-fork";

export interface ChatForkRow {
  sessionKey: string;
  parentTopicId: string;
  parentName: string;
  forkPointMessageId: string;
  runtime: ForkMode;
  parentRef: string | null;
  parentAt: string | null;
  branchRef: string | null;
  createdAt: string;
}

export function insertChatFork(db: Database, row: ChatForkRow): void {
  db.prepare(
    `INSERT INTO chat_forks (session_key, parent_topic_id, parent_name, fork_point_message_id, runtime, parent_ref, parent_at, branch_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.sessionKey, row.parentTopicId, row.parentName, row.forkPointMessageId, row.runtime, row.parentRef, row.parentAt, row.branchRef, row.createdAt);
}

/** The fork a session was born from, or null for a chat that is not a branch. */
export function readForkOrigin(db: Database, sessionKey: string): ForkOrigin | null {
  const row = db
    .prepare(`SELECT runtime, parent_ref, parent_at, branch_ref FROM chat_forks WHERE session_key = ?`)
    .get(sessionKey) as { runtime: string; parent_ref: string | null; parent_at: string | null; branch_ref: string | null } | null;
  return row ? { runtime: row.runtime, parentRef: row.parent_ref, parentAt: row.parent_at, branchRef: row.branch_ref } : null;
}

/** The fork consumed: the branch's memory is its own history from now on. */
export function consumeFork(db: Database, sessionKey: string): void {
  db.prepare(`UPDATE chat_forks SET parent_ref = NULL, parent_at = NULL WHERE session_key = ?`).run(sessionKey);
}

/**
 * The Claude Code sessions minted for a branch whose fork has not run yet. They
 * have no transcript on disk until the branch's first spawn, which can be days
 * away: the boot sweep of orphaned transcripts must leave them alone, or the
 * next spawn mints another uuid and the branch silently loses the original's
 * memory (`forkStartFor` is bound to `branch_ref`).
 */
export function pendingForkSessions(db: Database): Set<string> {
  const rows = db
    .prepare(`SELECT branch_ref FROM chat_forks WHERE runtime = 'claude-cli' AND parent_ref IS NOT NULL AND branch_ref IS NOT NULL`)
    .all() as Array<{ branch_ref: string }>;
  return new Set(rows.map((row) => row.branch_ref));
}
