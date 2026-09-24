/**
 * The rule of `finalized-turn-guard.ts`: once the turn is closed, every
 * callback is ignored and reported, except the two the route expects after its
 * own close.
 *
 * @covers CHAT-01
 */
import { describe, expect, test } from "bun:test";
import { silenceAfterFinalize } from "./finalized-turn-guard";
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
    onDone: () => { calls.push("done"); },
    onCompaction: () => { calls.push("compaction"); },
    onContextSize: (n: number) => { calls.push(`context:${n}`); },
    onError: (e: string) => { calls.push(`error:${e}`); },
    onAborted: () => { calls.push("aborted"); },
  } as unknown as StreamHandler;
  return { calls, handler };
}

describe("silenceAfterFinalize", () => {
  test("a live turn hears everything, unchanged", () => {
    const { calls, handler } = recorder();
    const dropped: string[] = [];
    const h = silenceAfterFinalize(handler, () => false, (e) => dropped.push(e));
    h.onTextDelta("a", "a");
    h.onToolStart("t1", "Bash");
    h.onToolResult("t1", "ok");
    h.onDone();
    expect(calls).toEqual(["text:a", "tool:t1", "result:t1", "done"]);
    expect(dropped).toEqual([]);
  });

  test("a closed turn ignores every callback, the ones nobody listed included, and says which", () => {
    const { calls, handler } = recorder();
    const dropped: string[] = [];
    const h = silenceAfterFinalize(handler, () => true, (e) => dropped.push(e));
    h.onTextDelta("late", "late");
    h.onToolStart("t2", "Bash");
    h.onToolResult("t2", "ok");
    h.onCallUsage?.({} as never);
    h.onDone();
    expect(calls).toEqual([]);
    expect(dropped).toEqual(["onTextDelta", "onToolStart", "onToolResult", "onCallUsage", "onDone"]);
  });

  test("the abort and the error the route itself provokes still reach the idempotent finalize", () => {
    const { calls, handler } = recorder();
    const dropped: string[] = [];
    const h = silenceAfterFinalize(handler, () => true, (e) => dropped.push(e));
    h.onAborted?.();
    h.onError("killed");
    expect(calls).toEqual(["aborted", "error:killed"]);
    expect(dropped).toEqual([]);
  });

  test("the session's own facts still land: a compaction and the context size are not the turn's row", () => {
    const { calls, handler } = recorder();
    const dropped: string[] = [];
    const h = silenceAfterFinalize(handler, () => true, (e) => dropped.push(e));
    h.onCompaction?.({} as never);
    h.onContextSize?.(1200);
    expect(calls).toEqual(["compaction", "context:1200"]);
    expect(dropped).toEqual([]);
  });

  test("a late question still reaches the person: its announcement is replayed first, then only that tool is heard", () => {
    const { calls, handler } = recorder();
    const dropped: string[] = [];
    const h = silenceAfterFinalize(handler, () => true, (e) => dropped.push(e));
    h.onToolStart("q1", "mcp__topics__ask_user_question");
    h.onToolArgsUpdate?.("q1", { questions: [] } as never);
    h.onTextDelta("prima di chiedere", "prima di chiedere");
    h.onToolStart("t2", "Bash");
    h.onUserInputRequired?.("q1", "mcp__topics__ask_user_question", { kind: "raw" } as never);
    h.onToolResult("q1", "risposta");
    h.onToolResult("t2", "ok");
    expect(calls).toEqual(["tool:q1", "args:q1", "ask:q1", "result:q1"]);
    expect(dropped).toEqual(["onToolStart", "onToolArgsUpdate", "onTextDelta", "onToolStart", "onToolResult"]);
  });

  test("the state is read at call time: the same handler goes deaf when the turn closes", () => {
    const { calls, handler } = recorder();
    let closed = false;
    const h = silenceAfterFinalize(handler, () => closed, () => {});
    h.onTextDelta("before", "before");
    closed = true;
    h.onTextDelta("after", "beforeafter");
    expect(calls).toEqual(["text:before"]);
  });
});
