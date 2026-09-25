/**
 * The rule of `finalized-turn-guard.ts`: once the turn is closed, each callback
 * goes to one of three lanes (the late handler, the live one, or nowhere), and
 * a live turn is untouched.
 *
 * @covers CHAT-01
 */
import { describe, expect, test } from "bun:test";
import { guardFinalizedTurn } from "./finalized-turn-guard";
import type { StreamHandler } from "../providers/types";

function recorder() {
  const calls: string[] = [];
  const handler = {
    onTextDelta: (t: string) => { calls.push(`text:${t}`); },
    onToolStart: (id: string) => { calls.push(`tool:${id}`); },
    onToolArgsUpdate: (id: string) => { calls.push(`args:${id}`); },
    onUserInputRequired: (id: string) => { calls.push(`ask:${id}`); },
    onToolResult: (id: string) => { calls.push(`result:${id}`); },
    onCallUsage: () => { calls.push("usage"); },
    onRetry: () => { calls.push("retry"); },
    onDone: () => { calls.push("done"); },
    onCompaction: () => { calls.push("compaction"); },
    onContextSize: (n: number) => { calls.push(`context:${n}`); },
    onError: (e: string) => { calls.push(`error:${e}`); },
    onAborted: () => { calls.push("aborted"); },
  } as unknown as StreamHandler;
  const heard: string[] = [];
  const dropped: string[] = [];
  const lane = {
    handlers: {
      onTextDelta: (t: string) => { calls.push(`late-text:${t}`); },
      onDone: () => { calls.push("late-done"); },
      onError: (e: string) => { calls.push(`late-error:${e}`); },
      onAborted: () => { calls.push("late-aborted"); },
    } as Partial<StreamHandler>,
    onHeard: (e: string) => { heard.push(e); },
    onDropped: (e: string) => { dropped.push(e); },
  };
  return { calls, handler, lane, heard, dropped };
}

describe("guardFinalizedTurn", () => {
  test("a live turn hears everything on its live handler, the late lane untouched", () => {
    const { calls, handler, lane, heard, dropped } = recorder();
    const h = guardFinalizedTurn(handler, () => false, lane);
    h.onTextDelta("a", "a");
    h.onToolStart("t1", "Bash");
    h.onDone();
    h.onError("boom");
    h.onAborted?.();
    expect(calls).toEqual(["text:a", "tool:t1", "done", "error:boom", "aborted"]);
    expect(heard).toEqual([]);
    expect(dropped).toEqual([]);
  });

  test("a closed turn: text and every end go to the late lane, never to the live code", () => {
    const { calls, handler, lane, heard } = recorder();
    const h = guardFinalizedTurn(handler, () => true, lane);
    h.onTextDelta("tardi", "tardi");
    h.onDone();
    h.onError("killed");
    h.onAborted?.();
    expect(calls).toEqual(["late-text:tardi", "late-done", "late-error:killed", "late-aborted"]);
    expect(heard).toEqual(["onTextDelta", "onDone", "onError", "onAborted"]);
  });

  test("a closed turn: the tool lifecycle and the session's facts stay on the live handlers, and are heard", () => {
    const { calls, handler, lane, heard, dropped } = recorder();
    const h = guardFinalizedTurn(handler, () => true, lane);
    h.onToolStart("q1", "mcp__topics__ask_user_question");
    h.onToolArgsUpdate?.("q1", { questions: [] } as never);
    h.onUserInputRequired?.("q1", "mcp__topics__ask_user_question", { kind: "raw" } as never);
    h.onToolResult("q1", "risposta");
    h.onCompaction?.({} as never);
    h.onContextSize?.(1200);
    expect(calls).toEqual(["tool:q1", "args:q1", "ask:q1", "result:q1", "compaction", "context:1200"]);
    // Heard first, so the lane knows a late answer started with a tool.
    expect(heard[0]).toBe("onToolStart");
    expect(heard).toHaveLength(6);
    expect(dropped).toEqual([]);
  });

  test("a closed turn: what is neither kept nor safe is dropped and reported, new callbacks included", () => {
    const { calls, handler, lane, heard, dropped } = recorder();
    const withNew = { ...handler, onSomethingNew: () => { calls.push("new"); } } as unknown as StreamHandler;
    const h = guardFinalizedTurn(withNew, () => true, lane) as unknown as Record<string, (...a: unknown[]) => void>;
    h.onCallUsage({});
    h.onRetry({});
    h.onSomethingNew();
    expect(calls).toEqual([]);
    expect(heard).toEqual([]);
    expect(dropped).toEqual(["onCallUsage", "onRetry", "onSomethingNew"]);
  });

  test("the state is read at call time: the same handler switches lane when the turn closes", () => {
    const { calls, handler, lane } = recorder();
    let closed = false;
    const h = guardFinalizedTurn(handler, () => closed, lane);
    h.onTextDelta("before", "before");
    closed = true;
    h.onTextDelta("after", "beforeafter");
    expect(calls).toEqual(["text:before", "late-text:after"]);
  });
});
