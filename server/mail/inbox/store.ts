/**
 * THE INBOX TABLES (rule P2): messages, cursor, health and the lease of a mailbox.
 *
 * `commitRound` is the ONE place that writes `mail_messages`, and it writes the
 * messages, lets the matcher of the waits look at the new rows, and saves the
 * cursor in one transaction. A stop anywhere inside leaves no message and the
 * old cursor, so the next round reads the same stretch again and finds neither
 * a hole nor a double. Never the body: the table has no column for it.
 */
import type { Database } from "bun:sqlite";
import type { ContractMessage } from "./contract";

export interface StoredMessage extends ContractMessage {
  rowId: number;
  mailbox: string;
  own: boolean;
}

export interface InboxState {
  mailbox: string;
  cursor: string | null;
  lastOkAt: string | null;
  lastTryAt: string | null;
  failures: number;
  lastError: string | null;
}

interface StateRow {
  mailbox: string; cursor: string | null; last_ok_at: string | null; last_try_at: string | null;
  failures: number; last_error: string | null;
}

export function readState(db: Database, mailbox: string): InboxState {
  const row = db.query("SELECT mailbox, cursor, last_ok_at, last_try_at, failures, last_error FROM mail_inbox_state WHERE mailbox = ?").get(mailbox) as StateRow | null;
  return row
    ? { mailbox, cursor: row.cursor, lastOkAt: row.last_ok_at, lastTryAt: row.last_try_at, failures: row.failures, lastError: row.last_error }
    : { mailbox, cursor: null, lastOkAt: null, lastTryAt: null, failures: 0, lastError: null };
}

/** Takes the mailbox for one round. False when another round (maybe another server) holds it. */
export function takeLease(db: Database, mailbox: string, owner: string, now: Date, ttlMs: number): boolean {
  const at = now.toISOString();
  const until = new Date(now.getTime() + ttlMs).toISOString();
  db.prepare("INSERT INTO mail_inbox_state (mailbox) VALUES (?) ON CONFLICT(mailbox) DO NOTHING").run(mailbox);
  return db.prepare("UPDATE mail_inbox_state SET lease_owner = ?, lease_until = ? WHERE mailbox = ? AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)")
    .run(owner, until, mailbox, at, owner).changes === 1;
}

export function releaseLease(db: Database, mailbox: string, owner: string): void {
  db.prepare("UPDATE mail_inbox_state SET lease_owner = NULL, lease_until = NULL WHERE mailbox = ? AND lease_owner = ?").run(mailbox, owner);
}

/** A failed round: the cursor stays where it was, the counter goes up. */
export function recordFailure(db: Database, mailbox: string, message: string, now: Date): void {
  const at = now.toISOString();
  db.prepare("INSERT INTO mail_inbox_state (mailbox, last_try_at, failures, last_error) VALUES (?, ?, 1, ?) ON CONFLICT(mailbox) DO UPDATE SET last_try_at = excluded.last_try_at, failures = failures + 1, last_error = excluded.last_error")
    .run(mailbox, at, message.slice(0, 300));
}

export interface CommitRound {
  mailbox: string;
  messages: ContractMessage[];
  cursor: string | null;
  now: Date;
  isOwn: (from: string) => boolean;
  /** Runs inside the transaction on the rows that are new: the point where the waits are matched. */
  onStored?: (fresh: StoredMessage[]) => void;
}

const INSERT_MESSAGE = `INSERT INTO mail_messages (mailbox, provider_id, thread_id, message_id, in_reply_to, from_addr, to_addrs, subject, snippet, auth_results, sent_at, received_at, own)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mailbox, provider_id) DO NOTHING`;

/** Writes one round. Returns the rows that were new. Throws with nothing written when anything inside fails. */
export function commitRound(db: Database, round: CommitRound): StoredMessage[] {
  const write = db.transaction((): StoredMessage[] => {
    const insert = db.prepare(INSERT_MESSAGE);
    const fresh: StoredMessage[] = [];
    for (const message of round.messages) {
      const own = round.isOwn(message.from);
      const result = insert.run(round.mailbox, message.id, message.threadId, message.messageId, message.inReplyTo, message.from, JSON.stringify(message.to), message.subject, message.snippet, message.authResults, message.sentAt, message.receivedAt, own ? 1 : 0);
      if (result.changes === 1) fresh.push({ ...message, rowId: Number(result.lastInsertRowid), mailbox: round.mailbox, own });
    }
    round.onStored?.(fresh);
    const at = round.now.toISOString();
    db.prepare("INSERT INTO mail_inbox_state (mailbox, cursor, last_ok_at, last_try_at, failures, last_error) VALUES (?, ?, ?, ?, 0, NULL) ON CONFLICT(mailbox) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at, last_try_at = excluded.last_try_at, failures = 0, last_error = NULL")
      .run(round.mailbox, round.cursor, at, at);
    return fresh;
  });
  return write.immediate();
}
