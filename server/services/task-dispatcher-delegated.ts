import type { DelegatedRunPolicy } from "../lib/delegated-agent-start";
import type { TurnEndInfo } from "../providers/stop-reason";
import type { StopCause } from "../lib/abort-cause";

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

/** Revalidate authority at the execution seam and enforce the persisted deadline. */
export async function runWithDelegatedDeadline(input: {
  resolvePolicy: () => DelegatedRunPolicy | null | undefined;
  persistedDeadlineAt: number | undefined;
  sessionKey: string;
  clock: () => number;
  abortTurn?: (sessionKey: string, cause: StopCause) => Promise<void>;
  run: () => Promise<TurnEndInfo | void>;
}): Promise<TurnEndInfo | void> {
  const policy = input.resolvePolicy();
  if (policy === undefined) return input.run();
  if (policy === null) throw new Error("delegated_authority_invalid");
  if (!input.abortTurn) throw new Error("delegated_duration_unenforceable");
  if (input.persistedDeadlineAt === undefined) throw new Error("delegated_deadline_missing");
  const remainingMs = input.persistedDeadlineAt - input.clock();
  if (remainingMs <= 0) throw new Error("delegated_duration_expired");
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<TurnEndInfo>((resolve) => {
    timer = setTimeout(() => {
      void input.abortTurn!(input.sessionKey, "wall-clock").finally(() => resolve({
        end: "cancelled",
        cause: "wall-clock",
        detail: "delegated maximum duration reached",
      }));
    }, remainingMs);
  });
  try { return await Promise.race([input.run(), deadline]); }
  finally { if (timer) clearTimeout(timer); }
}
