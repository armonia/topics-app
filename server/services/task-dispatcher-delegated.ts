import type { DelegatedRunPolicy } from "../lib/delegated-agent-start";
import type { TurnEndInfo } from "../providers/stop-reason";
import type { StopCause } from "../lib/abort-cause";
import { isHumanHold } from "../lib/human-hold";

const EFFORT_RANK = new Map([
  ["low", 0], ["medium", 1], ["high", 2], ["xhigh", 3], ["max", 4], ["ultra", 5],
]);

/** Apply the most restrictive board and delegated execution settings. */
export function effectiveDelegatedSettings<T extends { timeoutMin: number; effort: string; model?: string }>(
  settings: T,
  policy: DelegatedRunPolicy,
): T {
  const boardRank = EFFORT_RANK.get(settings.effort);
  const capabilityRank = EFFORT_RANK.get(policy.effort);
  const effort = boardRank === undefined || capabilityRank === undefined
    ? policy.effort
    : boardRank <= capabilityRank ? settings.effort : policy.effort;
  return {
    ...settings,
    timeoutMin: Math.min(settings.timeoutMin, policy.maxDurationMinutes),
    model: policy.model,
    effort,
  };
}

/**
 * How often a deadline that fell while a person was being asked checks again.
 * The human's time is subtracted at this grain: a few seconds of precision on a
 * limit counted in minutes.
 */
export const DELEGATED_HOLD_RECHECK_MS = 5_000;

/**
 * Revalidate authority at the execution seam and enforce the persisted deadline.
 *
 * THE PERSON'S TIME DOES NOT COUNT (29/09). The deadline limits how long the
 * delegated agent WORKS. A question on screen is the agent waiting for a
 * person, and a wall clock that ran through it killed the turn under a panel
 * nobody had answered (the same rule every other clock follows: HOLD-03). So
 * while `isHumanHold` says a question or a permission is open, the deadline
 * moves forward by the time spent waiting, and fires only on working time.
 */
export async function runWithDelegatedDeadline(input: {
  resolvePolicy: () => DelegatedRunPolicy | null | undefined;
  persistedDeadlineAt: number | undefined;
  sessionKey: string;
  clock: () => number;
  abortTurn?: (sessionKey: string, cause: StopCause) => Promise<void>;
  run: () => Promise<TurnEndInfo | void>;
  /** A person is being asked on this session right now. Defaults to the shared predicate. */
  isHumanHold?: (sessionKey: string) => boolean;
  /** Injectable timers, so a test can walk through hours without sleeping. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): Promise<TurnEndInfo | void> {
  const policy = input.resolvePolicy();
  if (policy === undefined) return input.run();
  if (policy === null) throw new Error("delegated_authority_invalid");
  if (!input.abortTurn) throw new Error("delegated_duration_unenforceable");
  if (input.persistedDeadlineAt === undefined) throw new Error("delegated_deadline_missing");
  let deadlineAt = input.persistedDeadlineAt;
  if (deadlineAt - input.clock() <= 0) throw new Error("delegated_duration_expired");
  const held = input.isHumanHold ?? isHumanHold;
  const setTimer = input.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = input.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let settled = false;
  const deadline = new Promise<TurnEndInfo>((resolve) => {
    // `heldSince`: when the current wait for a person started, or null.
    let heldSince: number | null = null;
    const check = () => {
      if (settled) return;
      const now = input.clock();
      if (held(input.sessionKey)) {
        heldSince ??= now;
        timer = setTimer(check, DELEGATED_HOLD_RECHECK_MS);
        return;
      }
      if (heldSince !== null) {
        deadlineAt += now - heldSince;
        heldSince = null;
      }
      const remaining = deadlineAt - now;
      if (remaining > 0) {
        timer = setTimer(check, Math.min(remaining, DELEGATED_HOLD_RECHECK_MS));
        return;
      }
      void input.abortTurn!(input.sessionKey, "wall-clock").finally(() => resolve({
        end: "cancelled",
        cause: "wall-clock",
        detail: "delegated maximum duration reached",
      }));
    };
    timer = setTimer(check, Math.min(deadlineAt - input.clock(), DELEGATED_HOLD_RECHECK_MS));
  });
  try { return await Promise.race([input.run(), deadline]); }
  finally { settled = true; if (timer !== null) clearTimer(timer); }
}
