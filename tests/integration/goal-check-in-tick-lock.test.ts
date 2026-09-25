/**
 * A CHECK-IN THAT MEETS A TICKING MONITOR IS NOT PAID AGAIN AT ONCE (third
 * review of 25/09, ported from the reviewer's probe).
 *
 * A check-in whose judge returned while a Monitor tick held the session was
 * "not spent" and left due: the tick's end re-armed it at 0, the judge met the
 * next tick, and so on. With a 25 s period, a 10 s tick turn and a 20 s judge,
 * 14 phases out of 25 paid 24-25 judges in 40 minutes and 145 in 90, with no
 * nudge ever sent: on claude-code each judge is a one-shot CLI of about 20 s.
 * A busy check-in now waits a full interval. Fake clock, every phase.
 *
 * @covers CHAT-GOALLOOP-01
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { setGoal, getActiveGoal } from "../../server/services/goals";
import { createGoalContinuation, type TurnEndInfo } from "../../server/services/goal-continuation";
import type { Topic } from "../../server/types";

beforeAll(() => setupTestDataDir(testTmpDir("goal-check-in-tick-lock")));
const S = 1000, MIN = 60 * S;

async function run(periodS: number, tickS: number, judgeS: number, horizonMin: number, offS = 0, humanAtMin?: number) {
  const ctx = await createTestAppContext();
  (ctx as any).broadcastToAll = () => {};
  const name = `tick-${periodS}-${tickS}-${judgeS}-${offS}`;
  const sk = `topic:${name}`;
  const topic = { id: `t-${name}`, name, slug: name, parentId: null, links: [], sessionKey: sk, color: "#000", icon: "x",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, provider: "openai" } as Topic;
  ctx.saveSingleTopic(topic);
  setGoal(ctx.db, { topicId: topic.id, content: "build watched to green" });
  let clock = 0; let busy = false;
  const q: Array<{ due: number; fn: () => void; seq: number }> = []; let seq = 0;
  const at = (due: number, fn: () => void) => { const h = { due, fn, seq: seq++ }; q.push(h); return h; };
  const judgedAt: number[] = []; const sent: string[] = []; const logs: string[] = [];
  /** The check-ins the loop armed, as opposed to the ticks this bench schedules. */
  const armedTimers = new Set<object>();
  const onTurnEnd = createGoalContinuation({
    db: ctx.db,
    judge: () => { judgedAt.push(clock); return new Promise<string>((r) => at(clock + judgeS * S, () => r("continue"))); },
    resend: async ({ text }) => { if (busy) throw new Error("409"); sent.push(text); },
    announce: () => {}, broadcast: () => {}, log: (m) => logs.push(`${(clock / S).toFixed(0)}s ${m}`),
    isBusy: () => busy, backgroundWork: () => true, wakeQueued: () => false,
    setTimer: (fn, ms) => { const h = at(clock + ms, fn); armedTimers.add(h); return h; },
    clearTimer: (h) => { const i = q.indexOf(h as never); if (i >= 0) q.splice(i, 1); },
    now: () => clock,
  });
  const turn = (over: Partial<TurnEndInfo>): TurnEndInfo => ({ sessionKey: sk, topicId: topic.id, dispatched: false, end: "end_turn", discarded: false,
    pendingAsk: false, usedTools: false, lastAssistantText: "", backgroundWork: true, ...over });
  await onTurnEnd(turn({ fromHuman: true, usedTools: true, lastAssistantText: "build started, Monitor on its log" }));
  // Monitor ticks: each wakes the CLI for tickS seconds (the session is busy), then the woken turn ends in words.
  for (let t = (periodS + offS) * S; t < horizonMin * MIN; t += periodS * S) {
    at(t, () => { busy = true; });
    at(t + tickS * S, () => { busy = false; void onTurnEnd(turn({ woken: true, lastAssistantText: "The monitor printed a line." })); });
  }
  // The person writes while the work runs, between two ticks.
  if (humanAtMin !== undefined) at(humanAtMin * MIN + (periodS - 5) * S, () => { void onTurnEnd(turn({ fromHuman: true, usedTools: true, lastAssistantText: "ok, still watching" })); });
  while (q.length) {
    q.sort((a, b) => a.due - b.due || a.seq - b.seq);
    const h = q.shift()!; if (h.due > horizonMin * MIN) break;
    clock = h.due; h.fn(); for (let i = 0; i < 5; i++) await Promise.resolve(); await Bun.sleep(0);
  }
  const g = getActiveGoal(ctx.db, topic.id);
  return {
    judged: judgedAt.length, judgedAtMin: judgedAt.map((j) => j / MIN), sent: sent.length, cont: g?.continuations, lastLogs: logs.slice(-4),
    pendingCheckIns: [...armedTimers].filter((h) => q.includes(h as never)).length,
  };
}

describe("a check-in against a ticking Monitor", () => {
  test("period 25 s, tick turn 10 s, judge 20 s: at most one judge per interval in any phase, over 40 minutes", async () => {
    for (let off = 0; off < 25; off++) {
      const r = await run(25, 10, 20, 40, off);
      expect({ off, judged: Math.min(r.judged, 3) }).toEqual({ off, judged: r.judged });
    }
  }, 120_000);

  test("the phase that locked, over 90 minutes", async () => {
    expect((await run(25, 10, 20, 90, 12)).judged).toBeLessThanOrEqual(3);
  }, 120_000);

  // Fourth review of 25/09: a busy check-in was not counted, so the interval
  // never doubled and the check-ins never paused. In the phase that locks,
  // 11 judges in 6 hours and no nudge. Claude Code spends it: 30, 60, 120, pause.
  test("a check-in the Monitor keeps busy is spent: the interval doubles, and after three the check-ins pause", async () => {
    const r = await run(25, 10, 20, 360, 12);
    expect(r.sent).toBe(0);
    expect(r.judged).toBe(3);
    const [first, second, third] = r.judgedAtMin;
    expect(second - first).toBeGreaterThanOrEqual(60);
    expect(third - second).toBeGreaterThanOrEqual(120);
    expect(r.pendingCheckIns).toBe(0);
    expect(r.lastLogs.at(-1)).toContain("check-ins paused until the next message");
  }, 120_000);

  test("the person's message lifts the pause: a check-in thirty minutes later", async () => {
    const r = await run(25, 10, 20, 360, 12, 300);
    expect(r.judged).toBe(4);
    expect(r.judgedAtMin[3] - 300).toBeGreaterThanOrEqual(30);
    expect(r.judgedAtMin[3] - 300).toBeLessThan(31);
  }, 120_000);
});
