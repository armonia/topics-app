/**
 * The stall judge: turns silence into a VERDICT instead of a cut.
 *
 * `dispatchIdleMin` says "this session's transcript has been quiet for N
 * minutes, go ask somebody cheap" — this module is that somebody. It reads
 * the tail of the transcript and answers exactly one of two words: "alive"
 * (still thinking, running a long tool, a human question left on screen) or
 * "stuck" (the same error looping, no progress, nothing left to wait for).
 * Only "stuck" is ever acted on — see `stall-detector.ts` for the caller that
 * wires this into a passive watch instead of a timer that kills on its own.
 *
 * PARSING IS EXACT MATCH, NOT SCAN-ORDER. A judge answer like "not alive, it
 * looks stuck" contains the substring "alive" before "stuck", so checking
 * `text.includes("alive") ? "alive" : "stuck"` in a fixed order would read the
 * word out of the model's own explanation instead of its verdict. This parser
 * looks for BOTH words as whole tokens and refuses to guess when it finds
 * zero or two — see `parseStallVerdict`.
 *
 * FAILS SAFE TO "alive": a judge call that throws, times out, or answers
 * something unparseable must never be read as "recycle" — recycling aborts a
 * live turn, and a judge that could not answer is not evidence of anything.
 */

export type StallVerdict = "alive" | "stuck";

/** The judge's one dependency: a single cheap completion call. */
export interface StallJudgeDeps {
  complete: (prompt: string) => Promise<string>;
}

const ALIVE_RE = /\balive\b/i;
const STUCK_RE = /\bstuck\b/i;

/**
 * Reads a verdict out of raw judge text. `null` when the answer names both
 * words, neither, or is otherwise not a clean single verdict — callers must
 * treat `null` exactly like a judge failure (fail safe, never recycle).
 */
export function parseStallVerdict(raw: string): StallVerdict | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const hasAlive = ALIVE_RE.test(text);
  const hasStuck = STUCK_RE.test(text);
  if (hasAlive === hasStuck) return null; // both or neither: no clean verdict
  return hasAlive ? "alive" : "stuck";
}

/** The prompt sent to the cheap judge — the transcript tail is the only variable. */
export function buildStallJudgePrompt(transcriptTail: string): string {
  return [
    "You are watching one coding-agent session that has gone silent for a while.",
    "Below is the TAIL of its transcript (most recent activity last).",
    "Decide: is the agent still doing real work (thinking, running a long tool, waiting on a human question shown on screen), or is it stuck (repeating the same error, looping with no progress, or waiting on nothing at all)?",
    "",
    "--- transcript tail ---",
    transcriptTail,
    "--- end transcript tail ---",
    "",
    'Answer with EXACTLY ONE WORD, no punctuation, no explanation: "alive" if it is still working, "stuck" if it is stuck.',
  ].join("\n");
}

/**
 * Runs the judge once and returns a verdict, never throwing: any failure
 * (network, parse) reads as "alive" — see the module doc for why that is the
 * only safe default.
 */
export async function judgeStall(deps: StallJudgeDeps, transcriptTail: string): Promise<StallVerdict> {
  try {
    const raw = await deps.complete(buildStallJudgePrompt(transcriptTail));
    return parseStallVerdict(raw) ?? "alive";
  } catch {
    return "alive";
  }
}
