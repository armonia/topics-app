/**
 * Persistence for compaction markers (CHAT-COMPACT-01).
 *
 * A marker records that the CLI compacted the context after a given message,
 * so the client can render a "context compacted" divider that survives reload.
 * Deliberately its own table — never joined into `messages`, never fed to
 * `build-provider-history`.
 */

import type { Database } from "bun:sqlite";
import type { CompactionMarker } from "../providers/claude/compaction";

export interface StoredCompactionMarker {
  id: string;
  topicId: string | null;
  sessionKey: string;
  afterMessageId: string | null;
  trigger: "auto" | "manual" | "unknown";
  preTokens?: number;
  postTokens?: number;
  createdAt: string;
}

function normTrigger(v: unknown): StoredCompactionMarker["trigger"] {
  return v === "auto" || v === "manual" ? v : "unknown";
}

/** Insert a marker and return the stored row. */
export function insertCompactionMarker(
  db: Database,
  input: {
    sessionKey: string;
    topicId?: string | null;
    afterMessageId?: string | null;
    marker: CompactionMarker;
  },
): StoredCompactionMarker {
  const row: StoredCompactionMarker = {
    id: crypto.randomUUID(),
    topicId: input.topicId ?? null,
    sessionKey: input.sessionKey,
    afterMessageId: input.afterMessageId ?? null,
    trigger: normTrigger(input.marker.trigger),
    ...(input.marker.preTokens != null ? { preTokens: input.marker.preTokens } : {}),
    ...(input.marker.postTokens != null ? { postTokens: input.marker.postTokens } : {}),
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO compaction_markers
       (id, topic_id, session_key, after_message_id, trigger, pre_tokens, post_tokens, created_at)
     VALUES ($id, $topic_id, $session_key, $after_message_id, $trigger, $pre_tokens, $post_tokens, $created_at)`,
  ).run({
    $id: row.id,
    $topic_id: row.topicId,
    $session_key: row.sessionKey,
    $after_message_id: row.afterMessageId,
    $trigger: row.trigger,
    $pre_tokens: row.preTokens ?? null,
    $post_tokens: row.postTokens ?? null,
    $created_at: row.createdAt,
  });
  return row;
}

function mapRow(r: Record<string, unknown>): StoredCompactionMarker {
  return {
    id: String(r.id),
    topicId: r.topic_id != null ? String(r.topic_id) : null,
    sessionKey: String(r.session_key),
    afterMessageId: r.after_message_id != null ? String(r.after_message_id) : null,
    trigger: normTrigger(r.trigger),
    ...(typeof r.pre_tokens === "number" ? { preTokens: r.pre_tokens } : {}),
    ...(typeof r.post_tokens === "number" ? { postTokens: r.post_tokens } : {}),
    createdAt: String(r.created_at),
  };
}

/** All markers for a session, oldest-first (creation order). */
export function getCompactionMarkersBySession(db: Database, sessionKey: string): StoredCompactionMarker[] {
  const rows = db
    .prepare(`SELECT * FROM compaction_markers WHERE session_key = ? ORDER BY created_at ASC, rowid ASC`)
    .all(sessionKey) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/** Backfill the post-compaction token count on the most recent marker that
 *  still lacks one (called from the following `result`'s usage). Best-effort. */
export function backfillPostTokens(db: Database, sessionKey: string, postTokens: number): void {
  if (!Number.isFinite(postTokens) || postTokens < 0) return;
  db.prepare(
    `UPDATE compaction_markers SET post_tokens = $post
       WHERE id = (
         SELECT id FROM compaction_markers
          WHERE session_key = $sk AND post_tokens IS NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1
       )`,
  ).run({ $post: postTokens, $sk: sessionKey });
}
