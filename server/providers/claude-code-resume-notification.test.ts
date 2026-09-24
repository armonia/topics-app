/**
 * A RESUMED SESSION ANSWERS A LEFTOVER NOTIFICATION FIRST, AND THAT ANSWER IS
 * NOT THE PERSON'S.
 *
 * Seen on 24/09 (topic 33966f4e: a person's message closed in 1.5 s as "no
 * reply") and recorded the same day with CLI 2.1.280: a session that had a background
 * task when it last ended is resumed, and before reading the person's message
 * it delivers the task's leftover notification as a turn of its own:
 *
 *   {"type":"system","subtype":"task_notification","status":"stopped",...}
 *   {"type":"system","subtype":"init",...}
 *   {"type":"result","subtype":"success","num_turns":0,"result":"","duration_ms":48}
 *   {"type":"system","subtype":"init",...}
 *   ... the person's turn ...
 *   {"type":"result","subtype":"success","num_turns":1,"result":"pong."}
 *
 * The first `result` closed the person's turn: the chat said nothing was
 * produced, and the real answer, a few seconds later, reached nobody.
 * @covers CCLI-05
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
    pendingReject: null,
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    activeToolCalls: new Map(),
    settledToolCalls: new Set(),
    streamingToolInputs: new Map(),
    spawnMeta: { isNewSession: false, claudeSessionId: "s" },
    lastEventAt: Date.now(),
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
    onTextDelta: () => {},
  };
}

const NOTIFICATION = {
  type: "system", subtype: "task_notification", task_id: "bcpwzslsf",
  tool_use_id: "toolu_01B44wb1PAZMSiyptdExUXzb", status: "stopped", output_file: "",
  summary: "Background shell command didn't finish before the previous session ended",
};
const INIT = { type: "system", subtype: "init" };
const NOTIFICATION_RESULT = {
  type: "result", subtype: "success", is_error: false, num_turns: 0, stop_reason: null, result: "", duration_ms: 48,
};
const PERSON_RESULT = {
  type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", result: "pong.", duration_ms: 4544,
};

describe("resume with a leftover task notification", () => {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const emit = (pp: unknown, event: unknown) => (provider as any).handleStreamEvent(pp, event);

  test("the notification's empty result does not close the person's turn", () => {
    const h = spyHandler();
    let resolved = 0;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved++; } });

    emit(pp, NOTIFICATION);
    emit(pp, INIT);
    emit(pp, NOTIFICATION_RESULT);

    expect(h.calls).toEqual([]);
    expect(resolved).toBe(0);
    expect(pp.streamHandler).toBe(h);

    emit(pp, INIT);
    emit(pp, PERSON_RESULT);
    expect(h.calls).toEqual(["done:pong."]);
    expect(resolved).toBe(1);
  });

  test("a /compact result is still the end of the turn (no notification before it)", () => {
    const h = spyHandler();
    let resolved = 0;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved++; } });
    emit(pp, INIT);
    emit(pp, { ...NOTIFICATION_RESULT, duration_ms: 46756 });
    expect(h.calls).toEqual(["done:"]);
    expect(resolved).toBe(1);
  });

  test("resume + notification + /compact: the notification's result is skipped, the compaction's closes", () => {
    const h = spyHandler();
    let resolved = 0;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved++; } });
    emit(pp, NOTIFICATION);
    emit(pp, NOTIFICATION_RESULT);
    expect(h.calls).toEqual([]);
    emit(pp, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 90000 } });
    emit(pp, { ...NOTIFICATION_RESULT, duration_ms: 46756 });
    expect(h.calls).toEqual(["done:"]);
    expect(resolved).toBe(1);
  });

  test("a stale notification never swallows a compaction's empty result", () => {
    const h = spyHandler();
    let resolved = 0;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved++; } });
    emit(pp, NOTIFICATION);
    emit(pp, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 90000 } });
    emit(pp, { ...NOTIFICATION_RESULT, duration_ms: 46756 });
    expect(h.calls).toEqual(["done:"]);
    expect(resolved).toBe(1);
  });

  test("the reattach fold (replaySilent) skips the notification's result as well", () => {
    const h = spyHandler();
    let resolved = 0;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved++; }, replaySilent: true });
    emit(pp, NOTIFICATION);
    emit(pp, NOTIFICATION_RESULT);
    expect(h.calls).toEqual([]);
    emit(pp, PERSON_RESULT);
    expect(h.calls).toEqual(["done:pong."]);
    expect(resolved).toBe(1);
  });

  test("the reattach scan (replayMute) does not arm the flag", () => {
    const pp = fakePP({ replayMute: true });
    emit(pp, NOTIFICATION);
    expect((pp as { notificationTurnPending?: boolean }).notificationTurnPending).toBeFalsy();
  });

  test("two leftover notifications share one empty result (recorded 24/09): still one skip", () => {
    const h = spyHandler();
    let resolved = 0;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved++; } });
    emit(pp, NOTIFICATION);
    emit(pp, { ...NOTIFICATION, task_id: "bz0sxgtaz" });
    emit(pp, INIT);
    emit(pp, { ...NOTIFICATION_RESULT, duration_ms: 37 });
    expect(h.calls).toEqual([]);
    emit(pp, INIT);
    emit(pp, PERSON_RESULT);
    expect(h.calls).toEqual(["done:pong."]);
    expect(resolved).toBe(1);
  });

  test("an ERROR result after a notification is never swallowed", () => {
    const h = spyHandler();
    let resolved = 0;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved++; } });
    emit(pp, NOTIFICATION);
    emit(pp, { ...NOTIFICATION_RESULT, subtype: "error_during_execution", is_error: true });
    expect(h.calls).toEqual(["done:"]);
    expect(resolved).toBe(1);
  });

  test("the flag is spent by one result: a later empty result closes normally", () => {
    const h = spyHandler();
    let resolved = 0;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved++; } });
    emit(pp, NOTIFICATION);
    emit(pp, NOTIFICATION_RESULT);
    emit(pp, NOTIFICATION_RESULT);
    expect(h.calls).toEqual(["done:"]);
    expect(resolved).toBe(1);
  });

  test("a notification that reaches a turn which then produced content does not swallow that turn's end", () => {
    const h = spyHandler();
    let resolved = 0;
    const pp = fakePP({ streamHandler: h, pendingResolve: () => { resolved++; } });
    emit(pp, NOTIFICATION);
    emit(pp, PERSON_RESULT);
    expect(h.calls).toEqual(["done:pong."]);
    expect(resolved).toBe(1);
  });
});
