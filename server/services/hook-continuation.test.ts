/**
 * The brakes of the turn a `turn-end` hook asks for, without a route.
 * @covers HOOKS-04
 */
import { describe, expect, test } from "bun:test";
import { HOOK_CONTINUATION_LIMIT, continueAfterTurnEndHook, hookNudgeAttemptOf } from "./hook-continuation";

const base = { sessionKey: "s", text: "carry on", endedAttempt: 0, endedCleanly: true, pendingAsk: false };

function deps(resend: (i: unknown) => Promise<void> = async () => {}) {
  const sent: unknown[] = [];
  const log: string[] = [];
  return { sent, log, deps: { resend: async (i: unknown) => { sent.push(i); await resend(i); }, log: (m: string) => log.push(m) } };
}

describe("continueAfterTurnEndHook", () => {
  test("sends the text once, marked hook-nudge, with the next attempt", async () => {
    const d = deps();
    expect(await continueAfterTurnEndHook({ ...base, endedAttempt: 1 }, d.deps)).toBe("sent");
    expect(d.sent).toEqual([{ sessionKey: "s", text: "carry on", attempt: 2, mark: "hook-nudge" }]);
  });

  test(`past ${HOOK_CONTINUATION_LIMIT} in a row: ignored and logged`, async () => {
    const d = deps();
    expect(await continueAfterTurnEndHook({ ...base, endedAttempt: HOOK_CONTINUATION_LIMIT }, d.deps)).toBe("capped");
    expect(d.sent).toEqual([]);
    expect(d.log[0]).toContain("ceiling");
  });

  test("a turn that did not end on its own, or waits on a question, is not continued", async () => {
    const d = deps();
    expect(await continueAfterTurnEndHook({ ...base, endedCleanly: false }, d.deps)).toBe("not-clean");
    expect(await continueAfterTurnEndHook({ ...base, pendingAsk: true }, d.deps)).toBe("waiting-human");
    expect(d.sent).toEqual([]);
  });

  test("never fatal: a 409 from the route is a log line, not a throw", async () => {
    const d = deps(async () => { throw new Error("the chat route answered 409"); });
    expect(await continueAfterTurnEndHook(base, d.deps)).toBe("failed");
    expect(d.log[0]).toContain("409");
  });
});

describe("hookNudgeAttemptOf", () => {
  test("the attempt that started the turn, 0 when no hook did", () => {
    expect(hookNudgeAttemptOf({ hookNudge: 2 })).toBe(2);
    expect(hookNudgeAttemptOf({ hookNudge: "2" })).toBe(0);
    expect(hookNudgeAttemptOf({ goalNudge: 1 } as never)).toBe(0);
    expect(hookNudgeAttemptOf(null)).toBe(0);
  });
});
