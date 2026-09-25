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
  const late: Partial<StreamHandler> = {
    onTextDelta: (t: string) => { calls.push(`late-text:${t}`); },
    onDone: () => { calls.push("late-done"); },
    onError: (e: string) => { calls.push(`late-error:${e}`); },
  };
  return { calls, handler, late };
}

describe("guardFinalizedTurn", () => {
  test("a live turn hears everything on its live handler, the late lane untouched", () => {
    const { calls, handler, late } = recorder();
    const dropped: string[] = [];
    const h = guardFinalizedTurn(handler, () => false, late, (e: string) => dropped.push(e));
    h.onTextDelta("a", "a");
    h.onToolStart("t1", "Bash");
    h.onDone();
    h.onError("boom");
    expect(calls).toEqual(["text:a", "tool:t1", "done", "error:boom"]);
    expect(dropped).toEqual([]);
  });

  test("a closed turn: text, end and error go to the late lane, never to the live code", () => {
    const { calls, handler, late } = recorder();
    const h = guardFinalizedTurn(handler, () => true, late, () => {});
    h.onTextDelta("tardi", "tardi");
    h.onDone();
    h.onError("killed");
    expect(calls).toEqual(["late-text:tardi", "late-done", "late-error:killed"]);
  });

  test("a closed turn: the tool lifecycle, the session's facts and the abort stay on the live handlers", () => {
    const { calls, handler, late } = recorder();
    const dropped: string[] = [];
    const h = guardFinalizedTurn(handler, () => true, late, (e: string) => dropped.push(e));
    h.onToolStart("q1", "mcp__topics__ask_user_question");
    h.onToolArgsUpdate?.("q1", { questions: [] } as never);
    h.onUserInputRequired?.("q1", "mcp__topics__ask_user_question", { kind: "raw" } as never);
    h.onToolResult("q1", "risposta");
    h.onCompaction?.({} as never);
    h.onContextSize?.(1200);
    h.onAborted?.();
    expect(calls).toEqual(["tool:q1", "args:q1", "ask:q1", "result:q1", "compaction", "context:1200", "aborted"]);
    expect(dropped).toEqual([]);
  });

  test("a closed turn: what is neither kept nor safe is dropped and reported, new callbacks included", () => {
    const { calls, handler, late } = recorder();
    const dropped: string[] = [];
    const withNew = { ...handler, onSomethingNew: () => { calls.push("new"); } } as unknown as StreamHandler;
    const h = guardFinalizedTurn(withNew, () => true, late, (e: string) => dropped.push(e)) as unknown as Record<string, (...a: unknown[]) => void>;
    h.onCallUsage({});
    h.onRetry({});
    h.onSomethingNew();
    expect(calls).toEqual([]);
    expect(dropped).toEqual(["onCallUsage", "onRetry", "onSomethingNew"]);
  });

  test("the state is read at call time: the same handler switches lane when the turn closes", () => {
    const { calls, handler, late } = recorder();
    let closed = false;
    const h = guardFinalizedTurn(handler, () => closed, late, () => {});
    h.onTextDelta("before", "before");
    closed = true;
    h.onTextDelta("after", "beforeafter");
    expect(calls).toEqual(["text:before", "late-text:after"]);
  });
});
