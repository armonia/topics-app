/**
 * THE CONTRACT OF A CARD AN AGENT OPENS (card a7ba2d05).
 *
 * A card born from an agent has to carry what lets it finish on its own:
 * context (a description), a place to work (a real board, so a directory), an
 * executable acceptance bar, and where it came from. Today a card that lacks
 * them is NOT refused (outside callers have not been updated yet): it is born
 * flagged, with a system comment saying what is missing, and the same list is
 * shown on the card. The refusal arrives when the callers are updated.
 */

export type AgentCardGap = "context" | "directory" | "bar" | "source";

/** Fewer characters than this is a title restated, not context. */
const MIN_CONTEXT_CHARS = 20;

export interface AgentCardFacts {
  description?: string | null;
  bar?: string | null;
  source?: string | null;
  /** True when the card sits on a real board (not `_auto` / `_none`). */
  hasDirectory: boolean;
}

/** What is still missing, in a fixed order. */
export function agentCardGaps(card: AgentCardFacts): AgentCardGap[] {
  const gaps: AgentCardGap[] = [];
  if ((card.description ?? "").trim().length < MIN_CONTEXT_CHARS) gaps.push("context");
  if (!card.hasDirectory) gaps.push("directory");
  if (!(card.bar ?? "").trim()) gaps.push("bar");
  if (!(card.source ?? "").trim()) gaps.push("source");
  return gaps;
}

const GAP_SENTENCES: Record<AgentCardGap, string> = {
  context: `a description with the context (at least ${MIN_CONTEXT_CHARS} characters)`,
  directory: "a real board with a working directory (board_id / project)",
  bar: "an executable acceptance bar (`bar`: the check that says it is done)",
  source: "where it comes from (`source`: the session or channel opening it)",
};

/** The system comment written on a card born incomplete. */
export function incompleteCardNotice(gaps: readonly AgentCardGap[]): string {
  return `Incomplete card: an agent opened it without ${gaps.map((g) => GAP_SENTENCES[g]).join("; ")}. It was accepted for now; the creation will be refused once the callers send these fields.`;
}
