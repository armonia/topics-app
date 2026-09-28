/**
 * HOW MANY TIMES THE RESUME SWEEP HAS RESENT A MESSAGE, as a number in the
 * database (`resend_counts`, card 069f823e).
 *
 * The count was read off the thread's shape: from the row the sweep judged up
 * `parent_id`, the highest `ripreso` number, stopping at the first assistant
 * row with none. A sub-agent's report, a system message or a background notice
 * under a resent answer is such a row, so the walk stopped there, every link
 * counted from zero, and neither cap ever triggered (probes of 28/09: seven
 * resends of one message in seven restarts, twenty of twenty into an API down
 * for good). Three rounds that read past those rows each opened a regression
 * of their own: a new message inheriting the old chain's attempts, a fresh wake
 * hung on a chain already answered. A number keyed by the message has no shape
 * to misread.
 *
 * The key is the message the chain resends. The sweep always resends the
 * chat's last user row, and each resend writes a copy of it through the chat
 * route: the sweep passes the key along (`resendOf`), and the route writes the
 * copy's id on the row (`noteResendCopy`). From then on the copy leads back to
 * the key, and the person's next message leads to nothing: it starts from
 * zero by construction.
 *
 * A chain ends when it is answered: the turn the last resend opened ended by
 * itself (`end_reason = 'done'`). Whatever is cut after that (a wake the CLI
 * opens once its background work ends) is a new chain, keyed by that copy.
 */
import type { Database } from "bun:sqlite";

/** The resends a chain has spent, and the message its next resend sends. */
export interface ResendChain {
  /** The key the count is written under. */
  messageId: string;
  /** Resends that spent an attempt (MAX_RESUME_ATTEMPTS). */
  attempts: number;
  /** Resends into an API still down that spent none (MAX_FREE_PROBES). */
  freeProbes: number;
}

/**
 * The chain whose next resend would send `lastUserId`, the chat's last user
 * row: the row keyed by it, or the one whose last copy it is. `null` when no
 * resend ever sent it, which is also every chain in flight before the table
 * existed (the caller's to read, see `chatHasCounts` and the migration). A
 * chain whose last copy was answered is over: a new one starts, keyed by that
 * copy.
 */
export function resendChainOf(db: Pick<Database, "query">, sessionKey: string, lastUserId: string): ResendChain | null {
  const row = db.query(
    `SELECT message_id, attempts, free_probes, last_copy_id FROM resend_counts
      WHERE session_key = ?1 AND (message_id = ?2 OR last_copy_id = ?2)
      ORDER BY message_id = ?2 DESC LIMIT 1`,
  ).get(sessionKey, lastUserId) as { message_id: string; attempts: number; free_probes: number; last_copy_id: string | null } | null;
  if (!row) return null;
  if (row.last_copy_id && answered(db, sessionKey, row.last_copy_id)) return { messageId: lastUserId, attempts: 0, freeProbes: 0 };
  return { messageId: row.message_id, attempts: row.attempts, freeProbes: row.free_probes };
}

/** Some resend of this chat was counted. Every resend of the sweep since the
 *  table exists is, so a chat with none has had no such resend since: the
 *  sweep's numbers its rows carry were written before the table. */
export function chatHasCounts(db: Pick<Database, "query">, sessionKey: string): boolean {
  return !!db.query(`SELECT 1 FROM resend_counts WHERE session_key = ? LIMIT 1`).get(sessionKey);
}

/** The turn opened for this copy of the message ended by itself. */
function answered(db: Pick<Database, "query">, sessionKey: string, copyId: string): boolean {
  return !!db.query(
    `SELECT 1 FROM messages WHERE session_key = ? AND parent_id = ? AND role = 'assistant' AND end_reason = 'done' LIMIT 1`,
  ).get(sessionKey, copyId);
}

/** The count after a resend, written with the sweep's trace and before the
 *  resend goes out, as the trace is. The last copy stays until the route
 *  writes the new one. */
export function recordResend(db: Pick<Database, "prepare">, sessionKey: string, chain: ResendChain): void {
  db.prepare(
    `INSERT INTO resend_counts (message_id, session_key, attempts, free_probes, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET attempts = excluded.attempts, free_probes = excluded.free_probes, updated_at = excluded.updated_at`,
  ).run(chain.messageId, sessionKey, chain.attempts, chain.freeProbes, new Date().toISOString());
}

/** The copy a resend just wrote, by the chat route, right after the row. */
export function noteResendCopy(db: Pick<Database, "prepare">, sessionKey: string, messageId: string, copyId: string): void {
  db.prepare(`UPDATE resend_counts SET last_copy_id = ? WHERE message_id = ? AND session_key = ?`).run(copyId, messageId, sessionKey);
}
