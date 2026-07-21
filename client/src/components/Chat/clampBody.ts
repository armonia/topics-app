/**
 * Oversized-body clamp (CHAT-PERF-01).
 *
 * A tool result or message body can be multi-megabyte (a `cat` of a big file,
 * a firehose `BashOutput`). Even inside a `max-h` scroll container the full
 * text lands in one DOM text node — layout + selection + any per-render work
 * scales with its length. Clamp the inline copy and gate the rest behind an
 * explicit expand, so the common case never pays for the pathological one.
 *
 * Pure + React-free so it unit-tests under bun:test.
 */

/** Inline budget before a body collapses behind a "show all" toggle (~20 KB). */
export const CLAMP_CHARS = 20_000;

export interface ClampResult {
  /** The slice to render when collapsed (full text when not oversized). */
  shown: string;
  /** True when the body exceeds the budget and was truncated. */
  oversized: boolean;
  /** Original length in bytes-ish (chars), for the "show all (N KB)" label. */
  length: number;
}

export function clampBody(text: string, max: number = CLAMP_CHARS): ClampResult {
  const length = text.length;
  if (length <= max) return { shown: text, oversized: false, length };
  return { shown: text.slice(0, max), oversized: true, length };
}

/** "12 KB" / "3.4 MB" — human size for the expand affordance. */
export function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(0)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}
