/**
 * Activity Log helper — central writer for the `activity_log` table.
 *
 * The table has existed since migration 001 but was never populated. This
 * module gives the rest of the server one tiny, typed entry point so timeouts,
 * errors, and stream completions leave a trail we can grep, instead of
 * scrolling through stdout. Bounded at MAX_ROWS to prevent runaway growth.
 *
 * Design notes:
 *  - Writes are best-effort: a failure to log MUST NOT break the caller. We
 *    swallow errors with a `console.warn` so a corrupt DB row doesn't take
 *    down a stream.
 *  - Retention is checked per-insert (cheap COUNT + DELETE). Could move to a
 *    cron later if the per-insert cost shows up in profiles, but for the
 *    expected volume (~handfuls per minute) this is fine.
 *  - `metadata` is JSON-stringified. Keep payloads small — this is a log,
 *    not a search index.
 */

import { getDatabase } from "../db";

/** Maximum rows kept in `activity_log`. Older rows are deleted on insert. */
const MAX_ROWS = 10_000;

export type ActivityLevel = "debug" | "info" | "warn" | "error";

export interface ActivityLogEntry {
  category: string;
  level?: ActivityLevel;
  title: string;
  detail?: string;
  entityType?: string;
  entityId?: string;
  actor?: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Insert one row into `activity_log`. Errors are swallowed (logged to stderr)
 * so callers don't have to wrap every call in try/catch.
 */
export function logActivity(entry: ActivityLogEntry): void {
  try {
    const db = getDatabase();
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    db.run(
      `INSERT INTO activity_log
        (id, timestamp, category, level, title, detail, entity_type, entity_id, actor, session_key, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        timestamp,
        entry.category,
        entry.level ?? "info",
        entry.title,
        entry.detail ?? null,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.actor ?? null,
        entry.sessionKey ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
    enforceRetention(db);
  } catch (err) {
    console.warn("[activity-log] insert failed:", (err as Error)?.message || err);
  }
}

/**
 * If the table exceeds MAX_ROWS, delete the oldest excess rows so it stays
 * bounded. We sort by timestamp ASC (oldest first) and delete the count diff.
 *
 * Skipping the count check until insert #N+1 would be marginally cheaper but
 * complicates startup — doing it on every insert keeps the invariant simple
 * and the cost is one indexed COUNT + at most one DELETE … LIMIT.
 */
function enforceRetention(db: ReturnType<typeof getDatabase>): void {
  try {
    const row = db.query("SELECT COUNT(*) AS c FROM activity_log").get() as { c: number } | null;
    const count = row?.c ?? 0;
    if (count <= MAX_ROWS) return;
    const excess = count - MAX_ROWS;
    db.run(
      `DELETE FROM activity_log
       WHERE id IN (
         SELECT id FROM activity_log ORDER BY timestamp ASC LIMIT ?
       )`,
      [excess],
    );
  } catch (err) {
    console.warn("[activity-log] retention check failed:", (err as Error)?.message || err);
  }
}

// ── Typed wrappers for the stream lifecycle ─────────────────────────────────
// These are the only call sites the timeout-resilience change adds. Centralizing
// the shape here means changing the metadata schema later is a one-file edit.

export interface StreamLogContext {
  sessionKey: string;
  topicId?: string;
  durationMs?: number;
  toolCallCount?: number;
  subAgentParentCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  costCents?: number;
  errorMessage?: string;
  /** Free-form extension. Avoid putting big strings here. */
  extra?: Record<string, unknown>;
}

/**
 * Log a soft inactivity timeout (provider went quiet for ≥ STREAM_TIMEOUT_MS
 * with no tool calls running).
 */
export function logStreamSoftTimeout(ctx: StreamLogContext): void {
  logActivity({
    category: "stream",
    level: "warn",
    title: "stream soft timeout",
    sessionKey: ctx.sessionKey,
    entityType: "topic",
    entityId: ctx.topicId,
    metadata: {
      durationMs: ctx.durationMs,
      toolCallCount: ctx.toolCallCount,
      subAgentParentCount: ctx.subAgentParentCount,
      ...ctx.extra,
    },
  });
}

/**
 * Log a hard timeout (absolute upper bound reached). Indicates a true hang —
 * provider never recovered after the soft timeout grace period.
 */
export function logStreamHardTimeout(ctx: StreamLogContext): void {
  logActivity({
    category: "stream",
    level: "error",
    title: "stream hard timeout (30 min)",
    sessionKey: ctx.sessionKey,
    entityType: "topic",
    entityId: ctx.topicId,
    metadata: {
      durationMs: ctx.durationMs,
      toolCallCount: ctx.toolCallCount,
      subAgentParentCount: ctx.subAgentParentCount,
      ...ctx.extra,
    },
  });
}

/** Provider error during streaming. */
export function logStreamError(ctx: StreamLogContext): void {
  logActivity({
    category: "stream",
    level: "error",
    title: "stream provider error",
    detail: ctx.errorMessage,
    sessionKey: ctx.sessionKey,
    entityType: "topic",
    entityId: ctx.topicId,
    metadata: {
      durationMs: ctx.durationMs,
      toolCallCount: ctx.toolCallCount,
      ...ctx.extra,
    },
  });
}

/** Successful stream completion. */
export function logStreamComplete(ctx: StreamLogContext): void {
  logActivity({
    category: "stream",
    level: "info",
    title: "stream completed",
    sessionKey: ctx.sessionKey,
    entityType: "topic",
    entityId: ctx.topicId,
    metadata: {
      durationMs: ctx.durationMs,
      promptTokens: ctx.promptTokens,
      completionTokens: ctx.completionTokens,
      costCents: ctx.costCents,
      ...ctx.extra,
    },
  });
}

/**
 * Un turno annullato.
 *
 * `title` è un PARAMETRO e non una costante da quando si è scoperto che il
 * titolo fisso «stream aborted by user» era l'unica traccia lasciata da uno
 * spegnimento del server sopra un turno vivo (20/08, topic:9f9e9629): chi
 * cercava la causa leggeva «l'utente», e l'utente non aveva toccato niente.
 * Chi chiama sa CHI ha annullato — lo decide `lib/cancelled-notice.ts` a
 * partire dalla `StopCause` — e il default resta quello storico per i
 * chiamanti che davvero parlano dello stop a mano.
 */
export function logStreamAborted(ctx: StreamLogContext & { title?: string }): void {
  logActivity({
    category: "stream",
    level: "info",
    title: ctx.title ?? "stream aborted by user",
    sessionKey: ctx.sessionKey,
    entityType: "topic",
    entityId: ctx.topicId,
    metadata: {
      durationMs: ctx.durationMs,
      toolCallCount: ctx.toolCallCount,
      ...ctx.extra,
    },
  });
}

/**
 * Provider recovered after a soft timeout — late event arrived during the
 * grace period and we resumed streaming. Useful to spot how often the
 * resilience layer actually saves a stream.
 */
export function logStreamRecovered(ctx: StreamLogContext): void {
  logActivity({
    category: "stream",
    level: "info",
    title: "stream recovered after soft timeout",
    sessionKey: ctx.sessionKey,
    entityType: "topic",
    entityId: ctx.topicId,
    metadata: {
      durationMs: ctx.durationMs,
      ...ctx.extra,
    },
  });
}

/** Read-only debug helper — fetch recent activity log rows. */
export interface ActivityLogRow {
  id: string;
  timestamp: string;
  category: string;
  level: ActivityLevel;
  title: string;
  detail: string | null;
  entity_type: string | null;
  entity_id: string | null;
  actor: string | null;
  session_key: string | null;
  metadata: string | null;
}

export interface ListActivityOptions {
  level?: ActivityLevel;
  category?: string;
  sessionKey?: string;
  since?: string;
  limit?: number;
}

export function listActivity(opts: ListActivityOptions = {}): ActivityLogRow[] {
  try {
    const db = getDatabase();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.level) { where.push("level = ?"); params.push(opts.level); }
    if (opts.category) { where.push("category = ?"); params.push(opts.category); }
    if (opts.sessionKey) { where.push("session_key = ?"); params.push(opts.sessionKey); }
    if (opts.since) { where.push("timestamp >= ?"); params.push(opts.since); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    params.push(limit);
    return db
      .query(`SELECT * FROM activity_log ${whereSql} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params) as ActivityLogRow[];
  } catch (err) {
    console.warn("[activity-log] list failed:", (err as Error)?.message || err);
    return [];
  }
}
