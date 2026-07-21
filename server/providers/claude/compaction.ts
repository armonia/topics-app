/**
 * Compaction-boundary parser (CHAT-COMPACT-01).
 *
 * The Claude Code CLI emits a `{ type: "system", subtype: "compact_boundary" }`
 * frame when it auto-compacts (or the user runs `/compact`) mid-session. The
 * provider drops all `system` frames as noise (claude-code.ts) — so today a
 * compaction is invisible in the chat. This pure parser lifts the boundary out
 * of that frame into a typed marker the route can broadcast + persist.
 *
 * DEFENSIVE by design: the exact metadata field names have drifted across CLI
 * versions, so we probe a few candidate keys and degrade gracefully — a marker
 * with `trigger: 'unknown'` and no token counts is still worth surfacing.
 * Pure + dependency-free so it unit-tests under bun:test.
 */

export interface CompactionMarker {
  /** What triggered the compaction, when the CLI tells us. */
  trigger: "auto" | "manual" | "unknown";
  /** Context size (tokens) just before compaction, when reported. */
  preTokens?: number;
  /** Context size (tokens) just after compaction — backfilled by the route
   *  from the following `result` usage, so absent at parse time. */
  postTokens?: number;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** True for a `system`/`compact_boundary` frame (the only thing we act on). */
export function isCompactBoundary(event: unknown): boolean {
  const e = asRecord(event);
  return e.type === "system" && e.subtype === "compact_boundary";
}

/**
 * Parse a `compact_boundary` system frame into a `CompactionMarker`, or return
 * null for anything else. Never throws.
 */
export function parseCompactBoundary(event: unknown): CompactionMarker | null {
  if (!isCompactBoundary(event)) return null;
  const e = asRecord(event);
  // Metadata has lived under a few keys across versions.
  const meta = asRecord(e.compact_metadata ?? e.compactMetadata ?? e.metadata ?? e.compaction);
  const rawTrigger = String((meta.trigger ?? meta.reason ?? e.trigger ?? "") as string).toLowerCase();
  const trigger: CompactionMarker["trigger"] =
    rawTrigger === "auto" || rawTrigger === "automatic"
      ? "auto"
      : rawTrigger === "manual" || rawTrigger === "user"
        ? "manual"
        : "unknown";
  const preTokens = num(meta.pre_tokens ?? meta.preTokens ?? meta.pre_token_count ?? meta.tokens_before);
  const marker: CompactionMarker = { trigger };
  if (preTokens != null) marker.preTokens = preTokens;
  return marker;
}
