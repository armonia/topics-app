// Interface-level handling of the CLI's auto-compaction preamble.
//
// When the headless `claude` CLI runs out of context it compacts and CONTINUES,
// and the continuation's output begins with a fixed preamble followed by a huge
// structured summary of the earlier conversation. The Topics server captures all
// stream text into the assistant message, so that summary leaks into the visible
// chat as a wall of prose. A `compact_boundary` divider is drawn separately, but
// the summary text itself is NOT handled — this splits it out so the renderer can
// fold it behind a compact "context summary" toggle instead of dumping ~24 KB of
// recap into the transcript.

/** The exact, CLI-owned preamble that marks the start of a compaction summary. */
export const COMPACTION_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context";

/**
 * Split a message body at the compaction-summary preamble. `before` is the real
 * prose (if any) that preceded it; `summary` is the preamble + recap to fold
 * away (null when the text carries no compaction summary). Pure — safe to memo.
 */
export function splitCompactionSummary(text: string): { before: string; summary: string | null } {
  if (!text) return { before: text, summary: null };
  const idx = text.indexOf(COMPACTION_PREAMBLE);
  if (idx < 0) return { before: text, summary: null };
  return { before: text.slice(0, idx).replace(/\s+$/, ""), summary: text.slice(idx) };
}
