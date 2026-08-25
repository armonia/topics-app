/**
 * Regression: the inactivity reaper must NOT reap a live child mid-turn.
 *
 * `resetInactivityTimer` arms a 15-min pool-cleanup timer at a turn's END so an
 * IDLE process is reclaimed between turns. The bug: that timer was never
 * cancelled when the NEXT turn began, so a turn running ≥15 min after the prior
 * turn ended was killed mid-work by the stale timer → `killProcess` →
 * `[claude-code] Inactivity timeout` → `[StaleStream] Auto-clearing` → the chat
 * died before reaching the end (observed on `topic:6b99e9cf`).
 *
 * The fix: `sendChatInternal` clears the timer at turn start and re-arms it in a
 * `finally` ONLY for a process that survived the turn. These tests pin that
 * invariant by driving the real `sendChatInternal` with a fully faked child.
  * @covers CCLI-02
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";

function fakePP(over: Record<string, unknown> = {}) {
  return {
    alive: true,
    aborting: false,
    streamHandler: null,
    fullText: "",
    activeToolCalls: new Map(),
    sidechain: { clear() {} },
    needsHistoryReplay: false,
    ready: Promise.resolve(),
    pendingResolve: null as null | ((v: { runId: string }) => void),
    pendingReject: null as null | ((e: unknown) => void),
    lastActivity: 0,
    inactivityTimer: null as ReturnType<typeof setTimeout> | null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    io: { writeStdin: (_s: string) => {}, kill: () => {}, signal: () => {} },
    readline: { close() {} },
    ...over,
  };
}

const noopHandler = {
  onError: () => {},
  onAborted: () => {},
  onDone: () => {},
} as never;

function setup(pp: ReturnType<typeof fakePP>, sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const p = provider as any;
  // Isolate the invariant: no real spawn, no real heartbeat interval.
  p.getOrCreateProcess = () => pp;
  p.startHeartbeat = () => {};
  p.stopHeartbeat = () => {};
  p.processes.set(sessionKey, pp);
  return provider;
}

describe("ClaudeCodeProvider — inactivity reaper never fires during a turn", () => {
  test("(a) success: timer cleared while the turn runs, re-armed after", async () => {
    const sessionKey = "sess-inact-a";
    const pp = fakePP();
    const provider = setup(pp, sessionKey);

    // Simulate a timer armed at the PREVIOUS turn's end.
    (provider as any).resetInactivityTimer(sessionKey, pp);
    expect(pp.inactivityTimer).not.toBeNull();

    // Capture the timer state AT THE MOMENT the turn is in flight (writeStdin
    // fires after the turn-start clear, before resolution).
    let timerDuringTurn: unknown = "unset";
    pp.io.writeStdin = () => {
      timerDuringTurn = pp.inactivityTimer;
      pp.pendingResolve?.({ runId: "r" }); // resolve the turn immediately
    };

    await (provider as any).sendChatInternal(sessionKey, "hi", noopHandler);

    expect(timerDuringTurn).toBeNull();       // ← the fix: no reaper mid-turn
    expect(pp.inactivityTimer).not.toBeNull(); // re-armed for the surviving idle process
    if (pp.inactivityTimer) clearTimeout(pp.inactivityTimer);
  });

  test("(b) abort keeps the child alive → timer re-armed after the turn", async () => {
    const sessionKey = "sess-inact-b";
    const pp = fakePP();
    const provider = setup(pp, sessionKey);
    (provider as any).resetInactivityTimer(sessionKey, pp);

    let timerDuringTurn: unknown = "unset";
    pp.io.writeStdin = () => {
      timerDuringTurn = pp.inactivityTimer;
      pp.pendingReject?.(new Error("ABORTED")); // user stop — child survives
    };

    await (provider as any).sendChatInternal(sessionKey, "hi", noopHandler);

    expect(timerDuringTurn).toBeNull();
    expect(pp.inactivityTimer).not.toBeNull();
    if (pp.inactivityTimer) clearTimeout(pp.inactivityTimer);
  });

  test("(c) dead/removed process is NOT re-armed", async () => {
    const sessionKey = "sess-inact-c";
    const pp = fakePP({ alive: false }); // PROCESS_DEAD path deletes it
    const provider = setup(pp, sessionKey);
    (provider as any).resetInactivityTimer(sessionKey, pp);
    expect(pp.inactivityTimer).not.toBeNull();

    await (provider as any).sendChatInternal(sessionKey, "hi", noopHandler);

    // Cleared at turn start; PROCESS_DEAD removes the process → finally skips
    // the re-arm. A dead child must not carry a live reaper handle.
    expect(pp.inactivityTimer).toBeNull();
    expect((provider as any).processes.get(sessionKey)).toBeUndefined();
  });
});
