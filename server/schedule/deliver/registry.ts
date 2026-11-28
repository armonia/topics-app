/**
 * THE REGISTER OF "ONCE ONLY" SENDS (rule R23 of change lavori-programmati-in-topics).
 *
 * Whatever sends something to a person outside the app (the outcome of a job,
 * an alert, and later a mail) asks this register first. Three promises:
 *  - the CALLER gives the key, so the same thing asked twice is one send;
 *  - `delivering` is written BEFORE the adapter is called, so a restart between
 *    the send and its record leaves a trace;
 *  - a row found `delivering` at boot becomes `unknown`: it may have gone out,
 *    so nothing starts it again by itself. Only a person decides about it.
 *
 * A mail adds one state BEFORE those (agent mail change, rule P8):
 * `pending`, the confirmation as a row that holds the message in
 * `payload_json` until its outcome. The boot rule does not touch it, so a
 * question survives a restart, and only `start` moves it on, once.
 */
import type { Database } from "bun:sqlite";

export type DeliveryState = "pending" | "delivering" | "delivered" | "delivery_failed" | "unknown" | "not_delivered" | "empty";

export interface DeliveryRow {
  key: string; kind: string; state: DeliveryState; attempts: number; detail: string | null;
}

export function createDeliveryRegistry(db: Database, now: () => Date = () => new Date()) {
  const get = (key: string) => db.query("SELECT key, kind, state, attempts, detail FROM deliveries WHERE key = ?").get(key) as DeliveryRow | null;

  return {
    get,
    /** True for the one caller that wrote the row. A key that exists, in any state, is never claimed twice. */
    claim(key: string, kind: string): boolean {
      const at = now().toISOString();
      return db.prepare("INSERT INTO deliveries (key, kind, state, attempts, created_at, updated_at) VALUES (?, ?, 'delivering', 0, ?, ?) ON CONFLICT(key) DO NOTHING")
        .run(key, kind, at, at).changes === 1;
    },
    /** A send that waits for a person: the row holds what will leave. False when the key already exists. */
    hold(key: string, kind: string, payload: unknown): boolean {
      const at = now().toISOString();
      return db.prepare("INSERT INTO deliveries (key, kind, state, attempts, payload_json, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT(key) DO NOTHING")
        .run(key, kind, JSON.stringify(payload), at, at).changes === 1;
    },
    /** What a `pending` (or later) row holds, or null. */
    payloadOf<T>(key: string): T | null {
      const row = db.query("SELECT payload_json FROM deliveries WHERE key = ?").get(key) as { payload_json: string | null } | null;
      return row?.payload_json ? (JSON.parse(row.payload_json) as T) : null;
    },
    /** Only while the person has not answered: what was confirmed is never rewritten. */
    updatePayload(key: string, payload: unknown): boolean {
      return db.prepare("UPDATE deliveries SET payload_json = ?, updated_at = ? WHERE key = ? AND state = 'pending'")
        .run(JSON.stringify(payload), now().toISOString(), key).changes === 1;
    },
    /**
     * The yes becomes a send, ONCE: `pending` to `delivering` is a conditional
     * update written before the adapter is called. Two roads holding the same
     * yes (the bridge leg and a click after a restart) cannot both win it.
     */
    start(key: string): boolean {
      return db.prepare("UPDATE deliveries SET state = 'delivering', attempts = attempts + 1, updated_at = ? WHERE key = ? AND state = 'pending'")
        .run(now().toISOString(), key).changes === 1;
    },
    /** The person said no, or the question could not be asked: nothing left, and nothing will. */
    drop(key: string, detail: string): boolean {
      return db.prepare("UPDATE deliveries SET state = 'not_delivered', detail = ?, updated_at = ? WHERE key = ? AND state = 'pending'")
        .run(detail, now().toISOString(), key).changes === 1;
    },
    /** Counts one more call to the adapter; written before the call. */
    beginAttempt(key: string): number {
      db.prepare("UPDATE deliveries SET attempts = attempts + 1, state = 'delivering', updated_at = ? WHERE key = ?").run(now().toISOString(), key);
      return get(key)?.attempts ?? 0;
    },
    /** Only a row still `delivering` moves: a late answer cannot overwrite what boot already judged. */
    finish(key: string, state: Exclude<DeliveryState, "delivering">, detail?: string | null): boolean {
      return db.prepare("UPDATE deliveries SET state = ?, detail = COALESCE(?, detail), updated_at = ? WHERE key = ? AND state = 'delivering'")
        .run(state, detail ?? null, now().toISOString(), key).changes === 1;
    },
    /** A send with no process to start (nothing configured, nothing to say) is recorded in one step. */
    record(key: string, kind: string, state: "not_delivered" | "empty", detail: string): boolean {
      const at = now().toISOString();
      return db.prepare("INSERT INTO deliveries (key, kind, state, attempts, detail, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?) ON CONFLICT(key) DO NOTHING")
        .run(key, kind, state, detail, at, at).changes === 1;
    },
    /** Boot: what was mid-send may have left. Returns how many rows became `unknown`. */
    recoverAtBoot(): number {
      return db.prepare("UPDATE deliveries SET state = 'unknown', detail = 'The server stopped while this was being sent: it may have gone out.', updated_at = ? WHERE state = 'delivering'")
        .run(now().toISOString()).changes;
    },
  };
}

export type DeliveryRegistry = ReturnType<typeof createDeliveryRegistry>;
