/**
 * THE SEND'S KEY, ASKED OF THE TABLE.
 *
 * A window mints one key per send (`clientMessageId`) and keeps it on every
 * resend of the same message. `POST /api/chat` writes it on the person's row
 * (`messages.client_message_id`, migration 20261003202540) and refuses a
 * second send under it with `duplicate_message`.
 *
 * The route's in-memory map answers first and stays the fast path, but it is
 * lost on every restart, and on this machine the server reloads on every save:
 * a message stored, its echo lost with the socket, the server reloaded, and the
 * outbound queue's resend under the same key was stored a second time. The
 * table outlives the process, so it is asked when the map has nothing.
 *
 * The unique index on (session_key, client_message_id) is the backstop for two
 * requests that both found nothing: the second write is refused by SQLite, and
 * the route answers that request as the duplicate it is, never a 500.
 */
import type { Database } from "bun:sqlite";

/** The id of the row this session already stored under `key`, or null. */
export function rowStoredUnderKey(db: Database | undefined, sessionKey: string, key: string): string | null {
  const row = db?.query(`SELECT id FROM messages WHERE session_key = ? AND client_message_id = ? LIMIT 1`).get(sessionKey, key) as
    | { id: string }
    | null
    | undefined;
  return row?.id ?? null;
}

const KEY_TAKEN = /UNIQUE constraint failed: messages\.session_key, messages\.client_message_id/;

/**
 * The row that took `key` first, when `err` is SQLite refusing a second row
 * under it in this session; null for any other error, which the caller rethrows.
 */
export function keyTakenBy(err: unknown, db: Database | undefined, sessionKey: string, key: string | null): string | null {
  if (!key || !(err instanceof Error) || !KEY_TAKEN.test(err.message)) return null;
  return rowStoredUnderKey(db, sessionKey, key);
}
