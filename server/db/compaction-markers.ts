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

/**
 * Insert a marker UNLESS the session's most-recent marker already anchors to
 * the same message. Repeated compactions inside a single turn share the same
 * anchor (`partialMsg.parentId` — no new message is persisted between them), so
 * a naive insert stacks several identical "context compacted" dividers at the
 * exact same transcript position. They convey nothing a single boundary doesn't
 * (same spot, same label) and make the chat look split into separate segments.
 *
 * On a same-anchor repeat we keep the existing boundary and only enrich its
 * token counts if the repeat carries ones the original lacked, returning it so
 * the caller re-broadcasts the SAME markerId (idempotent on the client). A
 * different anchor (a new turn / new persisted message) inserts normally.
 */
export function insertCompactionMarkerIfNew(
  db: Database,
  input: {
    sessionKey: string;
    topicId?: string | null;
    afterMessageId?: string | null;
    marker: CompactionMarker;
  },
): StoredCompactionMarker {
  const anchor = input.afterMessageId ?? null;
  const latest = db
    .prepare(
      `SELECT * FROM compaction_markers WHERE session_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(input.sessionKey) as Record<string, unknown> | undefined;
  if (latest) {
    const latestAnchor = latest.after_message_id != null ? String(latest.after_message_id) : null;
    if (latestAnchor === anchor) {
      const patch: string[] = [];
      const params: Record<string, string | number> = { $id: String(latest.id) };
      if (latest.pre_tokens == null && input.marker.preTokens != null) {
        patch.push("pre_tokens = $pre");
        params.$pre = input.marker.preTokens;
      }
      if (latest.post_tokens == null && input.marker.postTokens != null) {
        patch.push("post_tokens = $post");
        params.$post = input.marker.postTokens;
      }
      if (patch.length) {
        db.prepare(`UPDATE compaction_markers SET ${patch.join(", ")} WHERE id = $id`).run(params);
      }
      const row = db
        .prepare(`SELECT * FROM compaction_markers WHERE id = ?`)
        .get(String(latest.id)) as Record<string, unknown>;
      return mapRow(row);
    }
  }
  return insertCompactionMarker(db, input);
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
 *  still lacks one (called from the following `result`'s usage). Returns the
 *  updated marker so the caller can re-broadcast it (the divider then shows the
 *  pre→post delta live), or null when there was nothing to fill. Best-effort. */
export function backfillPostTokens(
  db: Database,
  sessionKey: string,
  postTokens: number,
): StoredCompactionMarker | null {
  if (!Number.isFinite(postTokens) || postTokens < 0) return null;
  const target = db
    .prepare(
      `SELECT id FROM compaction_markers
        WHERE session_key = ? AND post_tokens IS NULL
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionKey) as { id?: unknown } | undefined;
  if (!target?.id) return null;
  db.prepare(`UPDATE compaction_markers SET post_tokens = $post WHERE id = $id`).run({
    $post: postTokens,
    $id: String(target.id),
  });
  const row = db
    .prepare(`SELECT * FROM compaction_markers WHERE id = ?`)
    .get(String(target.id)) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}
