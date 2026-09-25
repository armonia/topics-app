/**
 * THE CHECK-IN AGAINST A CHAT THAT KEEPS BUSY: WHAT IT COSTS, AND THAT IT STILL
 * PUSHES (third and fourth reviews of 25/09, ported from the reviewers' probes).
 *
 * Third review: a check-in whose judge returned while a Monitor tick held the
 * session was "not spent" and left due: the tick's end re-armed it at 0, the
 * judge met the next tick, and so on. With a 25 s period, a 10 s tick turn and
 * a 20 s judge, 14 phases out of 25 paid 24-25 judges in 40 minutes and 145 in
 * 90, with no nudge ever sent: on claude-code each judge is a one-shot CLI of
 * about 20 s. A busy check-in now waits a full interval.
 *
 * Fourth review: given back whole, that interval never doubled (11 judges in 6
 * hours); counted toward the pause after three, a watcher that kept a chat busy
 * for 4 hours paused its goal with no nudge sent, silently. As in Claude Code a
 * busy check-in doubles the interval and leaves the pause alone; and a goal set
 * anew starts with check-ins of its own instead of inheriting a pause.
 *
 * Fake clock. A nudge starts a real turn (busy for a minute, then its end
 * reaches the loop); a tick that finds the chat busy does not start one.
 *
 * @covers CHAT-GOALLOOP-01
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { setGoal } from "../../server/services/goals";
import { createGoalContinuation, GOAL_CHECK_IN_MS, type TurnEndInfo } from "../../server/services/goal-continuation";
import type { Topic } from "../../server/types";

beforeAll(() => setupTestDataDir(testTmpDir("goal-check-in-tick-lock")));
const S = 1000, MIN = 60 * S;
let benches = 0;

interface Bench {
  horizonMin: number;
  judgeS?: number;
  /** A Monitor or a watcher: an event every `periodS` from `fromS` to `untilS`, each keeping the model busy `tickS`. */
  monitor?: { fromS: number; untilS: number; periodS: number; tickS: number };
  events?: Array<{ atS: number; fn: (bench: { topicId: string; turnEnd: (over: Partial<TurnEndInfo>) => void; setGoal: (content: string) => void }) => void }>;
}

async function sim(o: Bench) {
  const ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  const name = `tick-${benches++}`;
  const sk = `topic:${name}`;
  const topic = { id: `t-${name}`, name, slug: name, parentId: null, links: [], sessionKey: sk, color: "#000", icon: "x",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, provider: "openai" } as Topic;
  ctx.saveSingleTopic(topic);
  setGoal(ctx.db, { topicId: topic.id, content: "build watched to green" });
  let clock = 0; let busy = false;
  const q: Array<{ due: number; fn: () => void; seq: number }> = []; let seq = 0;
  const at = (due: number, fn: () => void) => { const h = { due, fn, seq: seq++ }; q.push(h); return h; };
  const judgedAt: number[] = []; const sentAt: number[] = [];
  /** The check-ins the loop armed, as opposed to the ticks this bench schedules. */
  const armedTimers = new Set<object>();
  const turn = (over: Partial<TurnEndInfo>): TurnEndInfo => ({ sessionKey: sk, topicId: topic.id, dispatched: false, end: "end_turn", discarded: false,
    pendingAsk: false, usedTools: false, lastAssistantText: "", backgroundWork: true, ...over });
  const loop: ReturnType<typeof createGoalContinuation> = createGoalContinuation({
    db: ctx.db,
    judge: () => { judgedAt.push(clock); return new Promise<string>((r) => at(clock + (o.judgeS ?? 20) * S, () => r("continue"))); },
    resend: ({ text: _text }) => {
      if (busy) return Promise.reject(new Error("409"));
      sentAt.push(clock); busy = true;
      return new Promise<void>((r) => at(clock + MIN, () => { busy = false; void loop(turn({ usedTools: true, lastAssistantText: "checked the build, still running" })); r(); }));
    },
    announce: () => {}, broadcast: () => {}, log: () => {},
    isBusy: () => busy, backgroundWork: () => true, wakeQueued: () => false,
    setTimer: (fn, ms) => { const h = at(clock + ms, fn); armedTimers.add(h); return h; },
    clearTimer: (h) => { const i = q.indexOf(h as never); if (i >= 0) q.splice(i, 1); },
    now: () => clock,
  });
  await loop(turn({ fromHuman: true, usedTools: true, lastAssistantText: "build started, Monitor on its log" }));
  if (o.monitor) {
    const m = o.monitor;
    for (let t = m.fromS * S; t < m.untilS * S; t += m.periodS * S) {
      let took = false;
      at(t, () => { if (busy) return; busy = true; took = true; });
      at(t + m.tickS * S, () => { if (!took) return; took = false; busy = false; void loop(turn({ woken: true, lastAssistantText: "The monitor printed a line." })); });
    }
  }
  const bench = {
    topicId: topic.id,
    turnEnd: (over: Partial<TurnEndInfo>) => { void loop(turn(over)); },
    setGoal: (content: string) => { setGoal(ctx.db, { topicId: topic.id, content }); },
  };
  for (const e of o.events ?? []) at(e.atS * S, () => e.fn(bench));
  while (q.length) {
    q.sort((a, b) => a.due - b.due || a.seq - b.seq);
    if (q[0].due > o.horizonMin * MIN) break; // left in the queue: still armed at the horizon
    const h = q.shift()!;
    clock = h.due; h.fn(); for (let i = 0; i < 5; i++) await Promise.resolve(); await Bun.sleep(0);
  }
  return {
    judged: judgedAt.length, judgedAtMin: judgedAt.map((j) => j / MIN), sentAtMin: sentAt.map((j) => j / MIN),
    pendingCheckIns: [...armedTimers].filter((h) => q.includes(h as never)).length,
  };
}

/** The phase-locking Monitor: a 25 s period, a 10 s tick turn, against a 20 s judge. */
const ticking = (horizonMin: number, offS: number) => ({ fromS: 25 + offS, untilS: horizonMin * 60, periodS: 25, tickS: 10 });

describe("a check-in against a chat that keeps busy", () => {
  test("period 25 s, tick turn 10 s, judge 20 s: at most one judge per interval in any phase, over 40 minutes", async () => {
    for (let off = 0; off < 25; off++) {
      const r = await sim({ horizonMin: 40, monitor: ticking(40, off) });
      expect({ off, judged: Math.min(r.judged, 3) }).toEqual({ off, judged: r.judged });
    }
  }, 120_000);

  test("the phase that locked, over 90 minutes", async () => {
    expect((await sim({ horizonMin: 90, monitor: ticking(90, 12) })).judged).toBeLessThanOrEqual(3);
  }, 120_000);

  test("a check-in the Monitor keeps busy doubles the interval and does not pause the loop", async () => {
    const r = await sim({ horizonMin: 360, monitor: ticking(360, 12) });
    // 11 judges in 6 hours on 595c4a946.
    expect(r.judged).toBeLessThanOrEqual(4);
    const [first, second, third] = r.judgedAtMin;
    expect(second - first).toBeGreaterThanOrEqual(60);
    expect(third - second).toBeGreaterThanOrEqual(120);
    // Busy is not a check-in the chat received: nothing paused, the next one is armed.
    expect(r.pendingCheckIns).toBe(1);
  }, 120_000);

  test("after a 4-hour busy watcher, with a dev server still listed, a check-in nudges the chat", async () => {
    const r = await sim({ horizonMin: 720, monitor: { fromS: 20, untilS: 240 * 60, periodS: 60, tickS: 45 } });
    expect(r.sentAtMin.filter((m) => m > 240).length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  test("the person's message starts a fresh stretch: a check-in thirty minutes later", async () => {
    const r = await sim({ horizonMin: 360, monitor: ticking(360, 12),
      events: [{ atS: 300 * 60 + 20, fn: (b) => b.turnEnd({ fromHuman: true, usedTools: true, lastAssistantText: "ok, still watching" }) }] });
    const after = r.judgedAtMin.filter((m) => m > 300);
    expect(after[0] - 300).toBeGreaterThanOrEqual(30);
    expect(after[0] - 300).toBeLessThan(31);
  }, 120_000);

  test("a goal set anew during the pause gets check-ins of its own", async () => {
    // A dev server listed and a quiet watcher: three check-ins reach the chat
    // (30, 60 and 120 minutes apart) and the loop pauses; at 300 minutes the
    // goal is rewritten from the bar, with no message.
    const r = await sim({ horizonMin: 480, monitor: { fromS: 17, untilS: 480 * 60, periodS: 20 * 60, tickS: 10 },
      events: [{ atS: 300 * 60, fn: (b) => b.setGoal("a different objective") }] });
    expect(r.sentAtMin.filter((m) => m < 300).length).toBe(3);
    expect(r.judgedAtMin.filter((m) => m > 300).length).toBeGreaterThanOrEqual(1);
    expect(r.judgedAtMin.filter((m) => m > 300)[0] - 300).toBeLessThan(GOAL_CHECK_IN_MS / MIN + 21);
  }, 120_000);
});
