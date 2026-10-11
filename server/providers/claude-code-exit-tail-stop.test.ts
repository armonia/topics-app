/**
 * A STOP WHILE A SEND WAITS FOR AN EXITED CHILD'S TAIL MUST HOLD.
 *
 * `processForTurn` awaited `exitTail` before the send registered in
 * `waitingSends`. A Stop pressed during that wait found no waiting send, and
 * when the tail landed the stopped send was written to a fresh child. The tail
 * waits for its late ack behind the daemon backlog, so the window is long.
 *
 * @covers CCLI-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";
import type { StreamHandler } from "./types";

function stubProcess(provider: ClaudeCodeProvider, sessionKey: string, alive: boolean) {
  const writes: string[] = [];
  const signals: string[] = [];
  const pp: any = {
    proc: null,
    readline: { on() {}, close() {} },
    io: { writeStdin: (d: string) => { writes.push(d); }, signal: (s: string) => { signals.push(s); }, kill: () => {} },
    ready: Promise.resolve(),
    sessionKey,
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "s", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive,
    streamHandler: null,
    pendingResolve: null,
    pendingReject: null,
    fullText: "",
    activeToolCalls: new Set(),
    settledToolCalls: new Set(),
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    lastEventAt: Date.now(),
    needsHistoryReplay: false,
    sidechain: new SidechainTracker(),
    pendingInputs: new Map(),
  };
  (provider as any).processes.set(sessionKey, pp);
  return { pp, writes, signals };
}

function handler() {
  const texts: string[] = [];
  let aborted = 0;
  const h: StreamHandler = {
    onTextDelta: (t: string) => { texts.push(t); },
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => {},
    onError: () => {},
    onAborted: () => { aborted++; },
  };
  return { h, texts, get aborted() { return aborted; } };
}

const emit = (provider: ClaudeCodeProvider, pp: unknown, event: unknown) => (provider as any).handleStreamEvent(pp, event);
const settle = () => new Promise((r) => setTimeout(r, 0));
const userLines = (writes: string[]) => writes.filter((w) => w.includes('"type":"user"'));

const providers: Array<{ provider: ClaudeCodeProvider; pp: unknown }> = [];
afterEach(() => {
  for (const { provider, pp } of providers.splice(0)) {
    try { (provider as any).cleanupTimers(pp); } catch { /* already gone */ }
    try { (provider as any).stopHeartbeat(pp); } catch { /* already gone */ }
  }
  ClaudeCodeProvider.observeWokenTurns(() => false);
  ClaudeCodeProvider.observeCliTurns(() => {});
});

describe("claude-code: a Stop while a send waits for an exited child's tail", () => {
  test("the stopped send never spawns nor writes, and its handler hears aborted once", async () => {
    const sk = "topic:exit-tail-stop";
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    // The child exited while detached: dead, its tail still on its way behind the backlog.
    const old = stubProcess(provider, sk, false);
    providers.push({ provider, pp: old.pp });
    let resolveTail!: () => void;
    old.pp.exitTail = new Promise<void>((r) => { resolveTail = r; });

    // A spawn after the tail would prove the stopped send ran anyway.
    let spawns = 0;
    let fresh: any = null;
    const freshWrites: string[] = [];
    (provider as any).spawnPersistentProcess = (_sk: string) => {
      spawns++;
      fresh = {
        proc: null,
        readline: { on() {}, close() {} },
        io: { writeStdin: (d: string) => { freshWrites.push(d); }, signal: () => {}, kill: () => {} },
        ready: Promise.resolve(),
        sessionKey: _sk,
        consumedOffset: 0,
        stderrBuf: "",
        spawnMeta: { claudeSessionId: "s", isNewSession: false },
        createdAt: Date.now(),
        lastActivity: Date.now(),
        alive: true,
        streamHandler: null,
        pendingResolve: null,
        pendingReject: null,
        fullText: "",
        activeToolCalls: new Set(),
        settledToolCalls: new Set(),
        inactivityTimer: null,
        lifetimeTimer: null,
        heartbeatInterval: null,
        subAgentEmit: new Map(),
        lastEventAt: Date.now(),
        needsHistoryReplay: false,
        sidechain: new SidechainTracker(),
        pendingInputs: new Map(),
      };
      providers.push({ provider, pp: fresh });
      return fresh;
    };

    const sent = handler();
    const send = provider.sendChat(sk, "msg", sent.h);
    await settle();
    await provider.abort(sk, undefined, "user");
    resolveTail();
    // Let the send wake from the tail: without the fix it spawns and writes here.
    await new Promise((r) => setTimeout(r, 200));
    if (spawns > 0 && fresh) {
      // The send ran anyway: close its turn so it settles instead of hanging the test.
      emit(provider, fresh, { type: "system", subtype: "init" });
      emit(provider, fresh, { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "late", duration_ms: 10 });
    }
    const res = await send;
    expect(res).toEqual({ runId: undefined, notSent: true });
    expect(spawns).toBe(0);
    expect(userLines(old.writes)).toEqual([]);
    expect(userLines(freshWrites)).toEqual([]);
    expect(sent.aborted).toBe(1);
  });
});
