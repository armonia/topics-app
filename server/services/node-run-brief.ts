/**
 * node-run-brief.ts — what a node is told about a card besides its title.
 *
 * A card that runs on this machine reads its own thread: the prompt sends the
 * agent to `get_task`, where the reviewer's feedback and the previous delivery
 * are waiting. A card that runs on a NODE has no such road. The node only knows
 * what `createRun` carried, and for a rerun it carried the same title and the
 * same description as the first round: the PC rewrote a README from scratch
 * three times and never added the line the reviewer had asked for twice,
 * because nothing the reviewer wrote ever left this machine.
 *
 * The thread therefore travels INSIDE the description. Not in a new field: a
 * node built before this change would silently drop an unknown field, and the
 * cloud node builds its prompt from the description alone. Every node already
 * hands the description to its agent as the task's data, so this is the one
 * road that reaches all of them without waiting for each to be updated.
 */
import type { TaskComment } from "../../shared/board";

/** One comment is cut here: a pasted log must not push the reviewer's words out of the brief. */
export const MAX_COMMENT_CHARS = 2_000;
/** The whole thread stops here and drops its OLDEST comments first. */
export const MAX_THREAD_CHARS = 8_000;

const THREAD_OPENING = [
  "--- THREAD OF THIS CARD (oldest first) ---",
  "This card was worked on before and the people involved wrote to each other. Read it before you start.",
  "The newest human comment is the review feedback: it takes priority over the description above, and every point in it is part of the job.",
  "Your checkout is clean. A previous delivery described below is NOT in it, so do the whole task again with the feedback applied; do not assume the files already contain it.",
].join("\n");

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_COMMENT_CHARS ? `${t.slice(0, MAX_COMMENT_CHARS)}\n[...cut: ${t.length - MAX_COMMENT_CHARS} characters more on the card]` : t;
}

function entry(c: TaskComment): string {
  const who = c.kind === "delivery" ? `${c.author}, previous delivery` : c.author;
  return `[${who}, ${c.createdAt}]\n${clip(c.content)}`;
}

/**
 * The description a node receives: the card's own, then its thread.
 *
 * Only what was SAID is carried: a person's or an agent's `comment`, and the
 * `delivery` statement. The dispatcher's bookkeeping (`service`, and the
 * `comment`s the system itself writes: «Consegnato dal nodo...», «Consegna senza
 * riassunto...»), the transitions (`status`) and the machine's review evidence
 * (`review-note`) are this board's business and would only crowd out the words
 * that matter. A card with nothing said keeps its description as it was, byte
 * for byte.
 */
export function nodeRunDescription(description: string | null | undefined, thread: readonly TaskComment[]): string {
  const own = description ?? "";
  const said = thread.filter((c) => c.content.trim() && (c.kind === "delivery" || (c.kind === "comment" && c.author !== "system")));
  if (said.length === 0) return own;
  // Newest first until the budget is spent, so what falls off is the oldest talk.
  const kept: string[] = [];
  let size = 0;
  for (let i = said.length - 1; i >= 0; i--) {
    const e = entry(said[i]!);
    if (kept.length > 0 && size + e.length > MAX_THREAD_CHARS) break;
    kept.push(e);
    size += e.length;
  }
  const omitted = said.length - kept.length;
  return [
    own.trim(),
    "",
    THREAD_OPENING,
    ...(omitted > 0 ? [`[${omitted} older comment(s) left out: they are on the card]`] : []),
    ...kept.reverse(),
    "--- END OF THREAD ---",
  ].join("\n").trim();
}
