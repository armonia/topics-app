/**
 * THE CLOCKS THAT KILL, against background work: one bound for all of them.
 *
 * The independent verification of d25a6ded7 (25/09) broke this part with
 * reproductions, copied here with the expected behaviour turned right side up:
 *
 *   B1  a Monitor's events are news: its wakes carry no `task_*` line and no
 *       `parent_tool_use_id`, and the child was killed two hours after the
 *       Monitor started while it kept reporting;
 *   B2  the stall judge, the clock that SIGINTed chat 3019832f, was released
 *       after thirty minutes of a silent background Bash that the reaper and the
 *       lifetime cap still called alive.
 *
 * Driven on the recorded CLI session (`claude/background-work.fixture.ts`).
 * @covers CCLI-02
 */
import { describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";
import { recordedBackgroundSession, recordedSessionCron } from "./claude/background-work.fixture";
/** Two hours: the one bound every killing clock shares (`BACKGROUND_WORK_CAP_MS`). */
const TWO_HOURS = 2 * 60 * 60_000;
import { armStallDetector } from "../lib/stall-detector";
import { registerProvider, removeProvider } from "./index";
import { stallBackgroundHold } from "./background-probes";

const events = recordedBackgroundSession();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const firstResult = events.findIndex((e) => e.type === "result");

function stub(sessionKey: string, registered = false) {
  const provider = registered
    ? registerProvider({ type: "claude-code" } as never) as ClaudeCodeProvider
    : new ClaudeCodeProvider({ type: "claude-code" });
  const counts = { kill: 0, sigint: 0 };
  const pp: any = {
    sessionKey, alive: true, streamHandler: null, pendingResolve: null, pendingReject: null,
    fullText: "", activeToolCalls: new Set(), subAgentEmit: new Map(), sidechain: new SidechainTracker(),
    pendingInputs: new Map(), lastEventAt: Date.now(), inactivityTimer: null, lifetimeTimer: null, heartbeatInterval: null,
    readline: { close() {} },
    io: { writeStdin: () => {}, signal: (s: string) => { if (s === "SIGINT") counts.sigint++; }, kill: () => { counts.kill++; } },
  };
  (provider as any).processes.set(sessionKey, pp);
  const feed = (list: Array<Record<string, unknown>>) => { for (const e of list) (provider as any).handleStreamEvent(pp, e); };
  return { provider, pp, counts, feed };
}

// The recorded Monitor wake "Tick-2 fired.": from its system/init to its result.
const tickText = events.findIndex((e: any) => e.type === "assistant" && JSON.stringify(e.message?.content).includes("Tick-2 fired."));
let tickFrom = tickText; while ((events[tickFrom] as any).subtype !== "init") tickFrom--;
let tickTo = tickText; while ((events[tickTo] as any).type !== "result") tickTo++;
const tickWake = events.slice(tickFrom, tickTo + 1);
// The recorded snapshot that lists the Monitor, kept to the Monitor alone (a persistent PR or log watch).
const snap = events.find((e: any) => e.subtype === "background_tasks_changed" && e.tasks?.length === 3) as any;
const monitorOnly = { ...snap, tasks: snap.tasks.filter((t: any) => t.description === "tick counter loop") };

describe("the clocks that kill, against background work", () => {
  test("B1: a Monitor delivering events is news, so the reaper leaves it alone past two hours", async () => {
    // The wake really carries nothing the old rule counted.
    expect(tickWake.some((e: any) => e.parent_tool_use_id)).toBe(false);
    expect(tickWake.some((e: any) => e.type === "system" && String(e.subtype).startsWith("task_"))).toBe(false);

    const sk = "topic:clocks-monitor";
    const { provider, pp, counts, feed } = stub(sk);
    // The Monitor as the CLI launched it: its tool call, its snapshot, its start.
    const monitorCall = events.find((e: any) => e.type === "assistant" && JSON.stringify(e.message?.content).includes('"name":"Monitor"')) as any;
    const monitorStarted = events.find((e: any) => e.subtype === "task_started" && e.description === "tick counter loop") as any;
    feed([monitorCall, monitorOnly, monitorStarted]);
    expect(provider.hasBackgroundWork(sk)).toBe(true);
    // The Monitor started just under two hours ago, and fires NOW.
    pp.background.lastSignalAt = Date.now() - TWO_HOURS + 40;
    feed(tickWake);
    pp.wokenBuffer = null; pp.declinedTurn = false; pp.streamHandler = null; // the wake was adopted and ended
    await sleep(80);
    expect(provider.hasBackgroundWork(sk)).toBe(true);
    (provider as any).resetInactivityTimer(sk, pp, { ms: 5 });
    await sleep(40);
    expect(counts.kill).toBe(0);
    if (pp.inactivityTimer) clearTimeout(pp.inactivityTimer);
  });

  test("two hours without news of listed work: the reaper closes it and says what it closed", async () => {
    const sk = "topic:clocks-closed";
    const { provider, pp, counts, feed } = stub(sk);
    feed(events.slice(0, firstResult + 1));
    pp.wokenBuffer = null; pp.declinedTurn = false;
    pp.background.lastSignalAt = Date.now() - TWO_HOURS - 1;
    const closed: Array<{ sk: string; tasks: string[] }> = [];
    ClaudeCodeProvider.observeBackgroundClosed((key, tasks) => { closed.push({ sk: key, tasks }); });
    try {
      (provider as any).resetInactivityTimer(sk, pp, { ms: 5 });
      await sleep(40);
      expect(counts.kill).toBe(1);
      expect(closed.length).toBe(1);
      expect(closed[0].sk).toBe(sk);
      expect(closed[0].tasks).toContain("tick counter loop");
      expect(closed[0].tasks.length).toBe(3);
    } finally {
      ClaudeCodeProvider.observeBackgroundClosed(() => {});
    }
  });

  test("the stall judge, past the same bound, closes the listed work and says so; a watchdog says it went with a stuck turn", async () => {
    const closed: Array<{ sk: string; tasks: string[]; why: string }> = [];
    ClaudeCodeProvider.observeBackgroundClosed((key, tasks, why) => { closed.push({ sk: key, tasks, why }); });
    try {
      const sk = "topic:clocks-stall-closed";
      const { provider, pp, counts, feed } = stub(sk);
      feed(events.slice(0, firstResult + 1));
      pp.wokenBuffer = null; pp.declinedTurn = false;
      pp.background.lastSignalAt = Date.now() - TWO_HOURS - 1;
      pp.streamHandler = { onAborted() {} };
      let judged = 0;
      let clock = Date.now();
      const timers: Array<() => void> = [];
      armStallDetector({
        idleMs: 5 * 60_000,
        isWaitingForHuman: () => false, isWaitingForChecks: () => false, isFrozen: () => false,
        isWaitingForBackground: () => provider.hasBackgroundWork(sk),
        getTail: () => "assistant: tool_use Bash (bun run dev) ...",
        judge: async () => { judged++; return "stuck"; },
        onStuck: () => { void provider.abort(sk, undefined, "stall"); },
        setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, now: () => clock,
      });
      clock += 5 * 60_000; timers.shift()!();
      await sleep(10);
      expect(judged).toBe(1);
      expect(counts.sigint).toBe(1);
      expect(closed).toEqual([{ sk, tasks: expect.arrayContaining(["tick counter loop"]), why: "silent" }]);
      // A second clock in the window before the child exits is the same close: one row.
      (provider as any).killProcess(pp, "idle");
      expect(closed.length).toBe(1);

      const sk2 = "topic:clocks-watchdog-closed";
      const second = stub(sk2);
      second.feed(events.slice(0, firstResult + 1));
      (second.provider as any).killProcess(second.pp, "watchdog");
      expect(closed[1]).toEqual({ sk: sk2, tasks: expect.arrayContaining(["tick counter loop"]), why: "stuck-turn" });
    } finally {
      ClaudeCodeProvider.observeBackgroundClosed(() => {});
    }
  });

  test("a session cron past its two hours: the reaper closes the CLI and the chat hears the cron went, flagged as a cron", async () => {
    // The recorded CronCreate call and result; only the result's date is moved.
    const cron = recordedSessionCron().map((l) => l.event as any);
    const call = cron.find((e) => e.type === "assistant" && e.message.content.some((b: any) => b.name === "CronCreate"));
    const armedAt = (at: number) => ({ ...cron.find((e) => e.tool_use_result?.id), timestamp: new Date(at).toISOString() });
    const closed: Array<{ sk: string; tasks: string[]; why: string; cron?: true }> = [];
    ClaudeCodeProvider.observeBackgroundClosed((key, tasks, why, cron) => { closed.push({ sk: key, tasks, why, cron }); });
    try {
      const sk = "topic:clocks-cron-cap";
      const { provider, pp, counts, feed } = stub(sk);
      feed([call, armedAt(Date.now() - TWO_HOURS - 1)]);
      pp.wokenBuffer = null; pp.declinedTurn = false;
      (provider as any).resetInactivityTimer(sk, pp, { ms: 5 });
      await sleep(40);
      expect(counts.kill).toBe(1);
      // Under `silent`, the reason every client already shipped has a sentence for; `cron`
      // lets a newer one say the bound counts from the arming (a /loop fired all along).
      expect(closed).toEqual([{ sk, tasks: ["57 9 25 9 * (cron)"], why: "silent", cron: true }]);

      // Armed a minute ago, it goes with a stuck turn like any listed task.
      const sk2 = "topic:clocks-cron-watchdog";
      const second = stub(sk2);
      second.feed([call, armedAt(Date.now() - 60_000)]);
      (second.provider as any).killProcess(second.pp, "watchdog");
      expect(closed[1]).toEqual({ sk: sk2, tasks: ["57 9 25 9 * (cron)"], why: "stuck-turn" });
    } finally {
      ClaudeCodeProvider.observeBackgroundClosed(() => {});
    }
  });

  /**
   * An armed cron cannot speak inside a turn of ours: the CLI holds its fire
   * until the turn's `result` (recorded 28/09 with CLI 2.1.283 and Topics'
   * argv: a one-shot due at 10:42:00Z fired 11 ms after the result of a turn
   * whose Bash ran until 10:42:03Z). A turn silent for minutes is not waiting
   * on it, so neither the stall judge nor the lifetime cap's wedged-turn rule
   * holds for it; the reaper and the goal loop, which read a closed turn, do.
   */
  test("a turn stuck in a session with an armed cron is judged, and a wedged one is recycled by the cap", async () => {
    const cron = recordedSessionCron().map((l) => l.event as any);
    const call = cron.find((e) => e.type === "assistant" && e.message.content.some((b: any) => b.name === "CronCreate"));
    const armedAMinuteAgo = { ...cron.find((e) => e.tool_use_result?.id), timestamp: new Date(Date.now() - 60_000).toISOString() };

    const sk = "topic:clocks-cron-stall";
    const { provider, pp, counts, feed } = stub(sk, true);
    let judged = 0;
    const timers: Array<() => void> = [];
    let now = Date.now();
    try {
      feed([call, armedAMinuteAgo]);
      expect(provider.hasBackgroundWork(sk)).toBe(true);
      // A turn of ours in flight, silent since.
      pp.streamHandler = { onAborted() {} };
      armStallDetector({
        idleMs: 5 * 60_000,
        isWaitingForHuman: () => false, isWaitingForChecks: () => false, isFrozen: () => false,
        // Wired as server.ts wires it.
        isWaitingForBackground: stallBackgroundHold(sk),
        getTail: () => "assistant: tool_use Bash (bun run dev) ...",
        judge: async () => { judged++; return "stuck"; },
        onStuck: () => { void provider.abort(sk, undefined, "stall"); },
        setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, now: () => now,
      });
      now += 5 * 60_000; timers.shift()!();
      await sleep(10);
      expect(judged).toBe(1);
      expect(counts.sigint).toBe(1);
    } finally {
      removeProvider("claude-code");
    }

    // A woken turn (no watchdog) wedged past the window: the cap ends it.
    const sk2 = "topic:clocks-cron-wedged";
    const second = stub(sk2);
    second.feed([call, armedAMinuteAgo]);
    second.pp.streamHandler = {};
    second.pp.lastEventAt = Date.now() - 1_000;
    (second.provider as any).armLifetime(second.pp, sk2, { ms: 20, rearmMs: 10, wedgedMs: 500 });
    await sleep(100);
    second.pp.lifetimeTimer?.clear();
    expect(second.counts.kill).toBe(1);
  });

  test("B2: the stall judge waits exactly as long as the other clocks: a Bash silent for 31 minutes is not judged", async () => {
    const sk = "topic:clocks-stall";
    // Registered, so the server's own door (`sessionHasBackgroundWork`) finds it.
    const { provider, pp, counts, feed } = stub(sk, true);
    feed(events.slice(0, firstResult + 1));
    pp.wokenBuffer = null; pp.declinedTurn = false;
    // A background Bash (a suite) launched 31 minutes ago: silent, as recorded.
    pp.background.lastSignalAt = Date.now() - 31 * 60_000;
    expect(provider.hasBackgroundWork(sk)).toBe(true);
    let judged = 0; let stuck = 0;
    const timers: Array<() => void> = [];
    let now = Date.now();
    try {
      armStallDetector({
        idleMs: 5 * 60_000,
        isWaitingForHuman: () => false, isWaitingForChecks: () => false, isFrozen: () => false,
        // Wired as server.ts wires it.
        isWaitingForBackground: stallBackgroundHold(sk),
        getTail: () => "assistant: tool_use Bash (npm test) ...",
        judge: async () => { judged++; return "stuck"; },
        onStuck: () => { stuck++; void provider.abort(sk, undefined, "stall"); },
        setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, now: () => now,
      });
      now += 5 * 60_000; timers.shift()!();
      await sleep(10);
      expect(judged).toBe(0);
      expect(stuck).toBe(0);
      expect(counts.sigint).toBe(0);
    } finally {
      removeProvider("claude-code");
    }
  });
});
