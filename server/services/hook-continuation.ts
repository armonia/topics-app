/**
 * THE TURN A `turn-end` HOOK ASKS FOR (HOOKS-04), Claude Code's Stop hook on
 * the native runtime.
 *
 * A `turn-end` command that exits 0 and prints `{"decision":"block","reason":
 * "<text>"}` (`lifecycle-hooks.ts` parses it) gets `<text>` sent to the same
 * chat as the next turn, so the agent carries on with its whole context and
 * its tools. The use that asked for it: an agent that ends with «puoi
 * chiuderla» is asked by a hook to run its own retrospective and apply it.
 *
 * ── Through the chat route, like the goal loop ───────────────────────────────
 * The text goes out through `ChatGoalLoop.resend`, the same door the goal loop
 * uses, for the same reason (`goal-continuation.ts` header): a second way of
 * talking to the provider would skip the route's guarantees, the 409 on a turn
 * already in flight first. The row is a `user` one marked `hook-nudge`, so the
 * transcript draws one service line and never the person saying it.
 *
 * ── The brakes ───────────────────────────────────────────────────────────────
 * The attempt travels on the row (`hookNudge: n` in the body, the block's
 * `attempt`): the turn that ends knows whether a hook started it, and how many
 * in a row. That is the whole counter, so it needs no state and survives a
 * restart; any turn not bought by a hook (the person, the goal loop, a wake)
 * starts again from zero. The hook reads it as `stop_hook_active`, and past
 * `HOOK_CONTINUATION_LIMIT` in a row the request is ignored and logged.
 *
 * A turn the person stopped, one parked on a question, one that died: none is
 * a turn that decided to stop on its own, and none is continued (Claude Code
 * does not run Stop on an interrupt either).
 *
 * ── Never fatal ──────────────────────────────────────────────────────────────
 * The turn that ended is over and written. Whatever goes wrong here (the route
 * refusing with a 409 because another turn took the session, a thrown error)
 * is a line in the log and nothing else.
 */

import type { ContinuationMark } from "./goal-continuation";

/** Consecutive hook continuations a session may chain before the request is ignored. */
export const HOOK_CONTINUATION_LIMIT = 3;

/**
 * The consecutive hook continuation that started this turn (1 = the first),
 * read from the chat route's body; 0 when no hook asked for it.
 */
export function hookNudgeAttemptOf(body: { hookNudge?: unknown } | null | undefined): number {
  const v = body?.hookNudge;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

interface HookContinuationInput {
  sessionKey: string;
  /** What the hook printed as `reason`. */
  text: string;
  /** `hookNudgeAttemptOf` of the turn that just ended. */
  endedAttempt: number;
  /** The model closed the turn by itself (`end_turn`) and nothing was discarded. */
  endedCleanly: boolean;
  /** A question of the chat still waits on its person. */
  pendingAsk: boolean;
}

interface HookContinuationDeps {
  resend: (input: { sessionKey: string; text: string; attempt: number; mark?: ContinuationMark }) => Promise<void>;
  log?: (msg: string) => void;
}

type HookContinuationResult = "sent" | "capped" | "not-clean" | "waiting-human" | "failed";

/** Send the continuation a `turn-end` hook asked for, under the brakes above. Never throws. */
export async function continueAfterTurnEndHook(
  input: HookContinuationInput,
  deps: HookContinuationDeps,
): Promise<HookContinuationResult> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const tag = `[lifecycle-hooks] ${input.sessionKey}: turn-end hook asked to continue`;
  if (!input.endedCleanly) {
    log(`${tag}, but the turn did not end on its own: not sent`);
    return "not-clean";
  }
  if (input.pendingAsk) {
    log(`${tag}, but a question waits on the person: not sent`);
    return "waiting-human";
  }
  const attempt = input.endedAttempt + 1;
  if (attempt > HOOK_CONTINUATION_LIMIT) {
    log(`${tag} again after ${input.endedAttempt} in a row: ceiling of ${HOOK_CONTINUATION_LIMIT} reached, ignored`);
    return "capped";
  }
  try {
    await deps.resend({ sessionKey: input.sessionKey, text: input.text, attempt, mark: "hook-nudge" });
    return "sent";
  } catch (err) {
    // A 409 (another turn took the session) lands here too: not sent, said so.
    log(`${tag}: not sent (${err instanceof Error ? err.message : String(err)})`);
    return "failed";
  }
}
