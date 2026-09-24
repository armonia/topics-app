/**
 * A MESSAGE SENT RIGHT AFTER A STOP MUST NOT LAND IN THE CHILD THAT IS DYING.
 *
 * Measured with CLI 2.1.280 (24/09): in stream-json mode a SIGINT does not
 * leave the child running for the next message. It prints the stopped turn's
 * tail and exits with code 0 within 0.3-0.7 s:
 *
 *   {"type":"user","message":{"content":[{"type":"tool_result","is_error":true,...}]}}
 *   {"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}
 *   {"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":3,"result":""}
 *   (exit 0)
 *
 * A send landing in that window reused the same process: it took the stopped
 * turn's result for the end of ITS turn («no reply» in 5-38 ms), and the text
 * it wrote to stdin died with the child. Prod: topic d6158ec6 on 22/09 at
 * 14:02:56 and 14:09:35, two task updates the agent never received; the log
 * since 16/09 has 5 of 6 stops followed by a send before the child's exit.
 * @covers CCLI-01
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";

function fakePP(over: Record<string, unknown> = {}) {
  return {
    alive: true,
    aborting: false,
    sessionKey: "topic:test",
    streamHandler: null as null | Record<string, unknown>,
    pendingResolve: null as null | ((v: unknown) => void),
    pendingReject: null as null | ((e: Error) => void),
    pendingInputs: new Map(),
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    activeToolCalls: new Map(),
    settledToolCalls: new Set(),
    streamingToolInputs: new Map(),
    spawnMeta: { isNewSession: false, claudeSessionId: "s" },
    lastEventAt: Date.now(),
    io: { signal: () => {}, writeStdin: () => {}, kill: () => {} },
    ...over,
  };
}

function spyHandler() {
  const calls: string[] = [];
  return {
    calls,
    onError: (m: string) => calls.push(`error:${m}`),
    onAborted: () => calls.push("aborted"),
    onDone: (m?: { result?: string }) => calls.push(`done:${m?.result ?? ""}`),
    onTextDelta: (t: string) => calls.push(`text:${t}`),
    onToolStart: () => calls.push("tool"),
    onToolResult: () => calls.push("tool-result"),
  };
}

const INTERRUPTED_TOOL = {
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", is_error: true, tool_use_id: "toolu_1", content: "The user doesn't want to proceed with this tool use." }] },
};
const INTERRUPTED_TEXT = {
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
};
const INTERRUPTED_RESULT = {
  type: "result", subtype: "error_during_execution", is_error: true, num_turns: 3, stop_reason: "tool_use", result: "", duration_ms: 4658,
};

describe("the stopped turn's tail after abort()", () => {
  test("is dropped: it closes no one and does not wake a spontaneous turn", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const spontaneousTurns: string[] = [];
    ClaudeCodeProvider.observeWokenTurns((sk) => spontaneousTurns.push(sk));
    try {
      const stopped = spyHandler();
      const pp = fakePP({ streamHandler: stopped });
      (provider as any).processes.set("topic:test", pp);
      await provider.abort("topic:test", undefined, "user");
      expect(stopped.calls).toEqual(["aborted"]);

      const emit = (event: unknown) => (provider as any).handleStreamEvent(pp, event);
      emit(INTERRUPTED_TOOL);
      emit(INTERRUPTED_TEXT);
      emit(INTERRUPTED_RESULT);

      expect(spontaneousTurns).toEqual([]);
      expect(stopped.calls).toEqual(["aborted"]);
    } finally {
      ClaudeCodeProvider.observeWokenTurns(() => {});
    }
  });

  test("a send in the window does not reuse the stopping child: it waits for the exit and gets a fresh one", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const writes: string[] = [];
    const stopping = fakePP({ streamHandler: spyHandler(), io: { signal: () => {}, writeStdin: (s: string) => writes.push(s), kill: () => {} } });
    (provider as any).processes.set("topic:test", stopping);
    await provider.abort("topic:test", undefined, "user");

    const fresh = fakePP();
    let spawned = 0;
    (provider as any).spawnPersistentProcess = () => { spawned++; return fresh; };

    // The child exits a moment later, as the real one does after SIGINT.
    setTimeout(() => (provider as any).onSessionClosed(stopping, 0), 30);
    const got = await (provider as any).processForTurn("topic:test");

    expect(got).toBe(fresh);
    expect(spawned).toBe(1);
    expect(writes).toEqual([]);
  });

  test("a child that never exits after the stop is killed at the cap, and the send still gets a fresh one", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    let killed = 0;
    const stopping = fakePP({ streamHandler: spyHandler(), io: { signal: () => {}, writeStdin: () => {}, kill: () => { killed++; } } });
    (provider as any).processes.set("topic:test", stopping);
    await provider.abort("topic:test", undefined, "user");

    const fresh = fakePP();
    (provider as any).spawnPersistentProcess = () => fresh;
    const got = await (provider as any).processForTurn("topic:test", 50);

    expect(got).toBe(fresh);
    expect(killed).toBe(1);
  });

  test("a live child that was not stopped is reused as before", async () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const live = fakePP();
    (provider as any).processes.set("topic:test", live);
    let spawned = 0;
    (provider as any).spawnPersistentProcess = () => { spawned++; return fakePP(); };
    expect(await (provider as any).processForTurn("topic:test")).toBe(live);
    expect(spawned).toBe(0);
  });
});
