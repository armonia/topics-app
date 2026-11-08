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
import type { OutputLanguage } from "../../shared/types";
import { languageDirective } from "../lib/topics-agent-prompt";

/** One comment is cut here: a pasted log must not push the reviewer's words out of the brief. */
export const MAX_COMMENT_CHARS = 2_000;
/**
 * The comments of the thread stop here and drop the OLDEST first. The opening and the markers around
 * them add about 700 characters on top, so the whole description is this plus the card's own text.
 */
export const MAX_THREAD_CHARS = 8_000;

const THREAD_OPENING = [
  "--- THREAD OF THIS CARD (oldest first) ---",
  "This card was worked on before and the people involved wrote to each other. Read it before you start.",
  "The newest human comment is the review feedback: it takes priority over the description above, and every point in it is part of the job.",
  "Your checkout is clean. A previous delivery described below is NOT in it, so do the whole task again with the feedback applied; do not assume the files already contain it.",
].join("\n");

/**
 * The newest review comment is the one a node must follow to the letter: a reviewer's list of defects
 * can run past 2.000 characters, and cutting its middle left the node fixing only the first two points
 * (three empty rounds on 31/10). It is carried whole up to this cap.
 */
export const MAX_REVIEW_CHARS = 20_000;

/** A cut comment keeps its END too: the request a reviewer closes on is usually the last paragraph. */
const CLIP_TAIL_CHARS = 600;

function clip(text: string, limit: number): string {
  const t = text.trim();
  if (t.length <= limit) return t;
  const head = limit - CLIP_TAIL_CHARS;
  // A node cannot open the card: say plainly that the middle is out of reach, and that it can ask for it.
  return `${t.slice(0, head)}\n[...cut: ${t.length - limit} characters of the middle are NOT reachable from this machine; if you need them, ask the reviewer...]\n${t.slice(-CLIP_TAIL_CHARS)}`;
}

function entry(c: TaskComment, limit: number): string {
  const who = c.kind === "delivery" ? `${c.author}, previous delivery` : c.author;
  // Files live on this machine: the node cannot open them, but it must know they exist.
  const files = c.media?.length ? `\n[+${c.media.length} attached file(s), not carried to this machine]` : "";
  return `[${who}, ${c.createdAt}]\n${clip(c.content, limit)}${files}`;
}

/**
 * The description a node receives: the card's own, then its thread.
 *
 * Only what was SAID is carried: a person's or an agent's `comment`, and the
 * `delivery` statement. The dispatcher's bookkeeping (`service`, and the
 * `comment`s the system itself writes, like «delivered by node X, branch
 * planted»), the transitions (`status`) and the machine's review evidence
 * (`review-note`) are this board's business and would only crowd out the words
 * that matter. A card with nothing said keeps its description as it was, byte
 * for byte.
 */
export function nodeRunDescription(description: string | null | undefined, thread: readonly TaskComment[]): string {
  const own = description ?? "";
  const said = thread.filter((c) => c.content.trim() && (c.kind === "delivery" || (c.kind === "comment" && c.author !== "system")));
  if (said.length === 0) return own;
  // The newest review comment (not a delivery) is the one carried whole.
  let newestReview = -1;
  for (let i = said.length - 1; i >= 0; i--) {
    if (said[i]!.kind === "comment") {
      newestReview = i;
      break;
    }
  }
  // Newest first until the budget is spent, so what falls off is the oldest talk.
  // The newest review is carried whole and does NOT count against the budget: otherwise a long review
  // pushes the previous delivery out of the brief.
  const kept: string[] = [];
  let size = 0;
  for (let i = said.length - 1; i >= 0; i--) {
    if (i === newestReview) {
      kept.push(entry(said[i]!, MAX_REVIEW_CHARS));
      continue;
    }
    const e = entry(said[i]!, MAX_COMMENT_CHARS);
    if (size + e.length > MAX_THREAD_CHARS) break;
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

/**
 * The board's language, as the closing block of what a node receives.
 *
 * A local card gets it twice, in `rolePrompt` and in the envelope's `languageLine`. A node gets
 * neither: the cloud builds its prompt from the title and the description alone, and the
 * CLAUDE.md that carries the rule on this machine is not in the public repository. On 26/10, with
 * the language set to Italian, three Cloud Claude cards delivered in Italian and the fourth in
 * English: nothing had asked for Italian, so the session picked. Same road as the thread, for the
 * same reason: every node hands the description to its agent.
 *
 * `auto` adds nothing: the card's own text is the language, and the description stays byte for byte.
 */
export function nodeRunLanguage(lang: OutputLanguage): string {
  if (lang === "auto") return "";
  return [
    "--- LANGUAGE ---",
    languageDirective(lang),
    "This covers every comment you write on the card and your closing summary (the delivery). THE CODE IS ANOTHER MATTER: identifiers, strings and code comments are always English.",
  ].join("\n");
}

/** The description plus the language block, when there is one. */
export function withNodeRunLanguage(description: string, lang: OutputLanguage | null | undefined): string {
  const block = lang ? nodeRunLanguage(lang) : "";
  if (!block) return description;
  return description.trim() ? `${description.trim()}\n\n${block}` : block;
}
