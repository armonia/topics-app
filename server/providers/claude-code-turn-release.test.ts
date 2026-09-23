/**
 * The turn-release observer: the adopted-session import sweep snaps its cursor
 * past a Topics-driven turn the moment that turn ends (see
 * `syncImportOffsetToEnd` in lib/claude-session-tracker.ts). If one ending path
 * forgot to tell it, that path's final answer came back as a bare duplicate.
 * So every way a turn ends must fire it, once, and nothing else may.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";
import type { StreamHandler } from "./types";

function makeProviderWithStubProcess(sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp: any = {
    proc: { stdin: { write() { return true; }, end() {} }, kill() {}, on() {}, stdout: { on() {} }, stderr: { on() {} } },
    readline: { on() {}, close() {} },
    io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
    ready: Promise.resolve(),
    sessionKey,
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "test-session", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
    streamHandler: null,
    pendingResolve: null,
    pendingReject: null,
    fullText: "",
    activeToolCalls: new Set(),
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
  return { provider, pp };
}

const handler = (): StreamHandler => ({
  onTextDelta: () => {},
  onToolStart: () => {},
  onToolResult: () => {},
  onDone: () => {},
  onError: () => {},
  onAborted: () => {},
});

function observe(): string[] {
  const released: string[] = [];
  ClaudeCodeProvider.observeTurnReleased((sk) => released.push(sk));
  return released;
}

describe("claude-code · turn release", () => {
  // Static observer: leave a no-op behind so no other test inherits ours.
  afterEach(() => ClaudeCodeProvider.observeTurnReleased(() => {}));

  test("a completed turn (`result`) releases once, and the session is no longer driven", () => {
    const released = observe();
    const { provider, pp } = makeProviderWithStubProcess("topic:done");
    provider.registerStreamHandler("topic:done", undefined, handler());
    expect(provider.isTurnProcessAlive("topic:done")).toBe(true);

    (provider as any).handleStreamEvent(pp, { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 10 });

    expect(released).toEqual(["topic:done"]);
    expect(provider.isTurnProcessAlive("topic:done")).toBe(false);
  });

  test("an aborted turn whose process exits releases too", () => {
    const released = observe();
    const { provider, pp } = makeProviderWithStubProcess("topic:abort");
    provider.registerStreamHandler("topic:abort", undefined, handler());
    pp.aborting = true;

    (provider as any).onSessionClosed(pp, 143);

    expect(released).toEqual(["topic:abort"]);
  });

  test("the route unregistering its handler releases; a second unregister does not", () => {
    const released = observe();
    const { provider } = makeProviderWithStubProcess("topic:route");
    provider.registerStreamHandler("topic:route", undefined, handler());

    provider.unregisterStreamHandler("topic:route");
    provider.unregisterStreamHandler("topic:route");

    expect(released).toEqual(["topic:route"]);
  });

  test("unregistering a handler that is no longer the current one releases nothing", () => {
    const released = observe();
    const { provider } = makeProviderWithStubProcess("topic:stale");
    const current = handler();
    provider.registerStreamHandler("topic:stale", undefined, current);

    provider.unregisterStreamHandler("topic:stale", handler());

    expect(released).toEqual([]);
    expect(provider.isTurnProcessAlive("topic:stale")).toBe(true);
  });
});
