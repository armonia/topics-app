/**
 * THE NUMBER OF A PROMPT: «this is the 50th thing I asked in this chat».
 *
 * Counted on the WHOLE active thread, on the server, because the client often
 * holds only its tail (`shared/history-paging.ts`): a count done there would
 * say «3» on what is really the 50th prompt. Only what the PERSON typed counts:
 * the goal loop's continuation, its stop line and the board's envelope are
 * rows the machine wrote (see `server/lib/user-row-marks.ts`), and the
 * gateway's context envelope is not a prompt either.
 */
import type { ContentBlock } from "./types";

/** The block kinds that mark a row as written by the machine, not a person or
 *  the model. Twin of `isMachineRow` on the client. */
export const MACHINE_ROW_KINDS = ["goal-nudge", "goal-stop", "dispatched-envelope"] as const;

/**
 * The same rule as SQL, for readers that do not load `blocks` (lean reads, the
 * sidebar previews). The marks are a few bytes of plain JSON, below the blob
 * compression threshold of `shared/message-blob.ts`, so a `LIKE` reads them; a
 * compressed blob is a real turn and never matches.
 */
export const MACHINE_ROW_SQL = `(blocks IS NOT NULL AND (${MACHINE_ROW_KINDS.map((k) => `blocks LIKE '%"kind":"${k}"%'`).join(" OR ")}))`;

const CONTEXT_PREFIX = "[Chat messages since your last reply";

export interface NumberableMessage {
  id: string;
  role: string;
  content?: string | null;
  blocks?: readonly ContentBlock[] | null;
}

export function isPersonPrompt(m: NumberableMessage, machineIds?: ReadonlySet<string>): boolean {
  if (m.role !== "user") return false;
  if (machineIds?.has(m.id)) return false;
  if ((m.content ?? "").startsWith(CONTEXT_PREFIX)) return false;
  return !(m.blocks ?? []).some((b) => (MACHINE_ROW_KINDS as readonly string[]).includes(b.kind));
}

/**
 * id -> 1-based number of each person prompt, in thread order. `machineIds`
 * serves readers whose rows came without `blocks`.
 */
export function promptNumbers(
  thread: readonly NumberableMessage[],
  machineIds?: ReadonlySet<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const m of thread) if (isPersonPrompt(m, machineIds)) out.set(m.id, ++n);
  return out;
}
