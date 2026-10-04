/**
 * A tool call announced again keeps the times it was first given: the server's
 * merge, and the rule the route applies to a re-adoption's replay.
 *
 * @covers CHAT-TOOL-12
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { firstTimes, keepFirstTimes, toolTimesOfRow } from "./tool-call-times";
import type { AppContext, ToolCall } from "../types";

describe("keepFirstTimes", () => {
  test("the first startedAt and endedAt win over a later announcement", () => {
    const incoming: { startedAt: number; endedAt: number; name: string } = { startedAt: 9, endedAt: 10, name: "Bash" };
    expect(keepFirstTimes({ startedAt: 1, endedAt: 2 }, incoming)).toEqual({ startedAt: 1, endedAt: 2, name: "Bash" });
  });

  test("a time not given yet is taken from the newcomer", () => {
    expect(keepFirstTimes({ startedAt: 1 }, { startedAt: 9, endedAt: 10 })).toEqual({ startedAt: 1, endedAt: 10 });
  });

  test("nothing to keep: the same reference", () => {
    const incoming = { startedAt: 5 };
    expect(keepFirstTimes(undefined, incoming)).toBe(incoming);
    expect(keepFirstTimes({ startedAt: 5 }, incoming)).toBe(incoming);
  });
});

describe("toolTimesOfRow and firstTimes", () => {
  test("the times of an adopted row, from its blocks and from its legacy column", () => {
    const blocks = JSON.stringify([{ kind: "text", text: "x" }, { kind: "tool", toolCall: { id: "a", startedAt: 1, endedAt: 2 } }]);
    const calls = JSON.stringify([{ id: "b", startedAt: 3 }]);
    const times = toolTimesOfRow(blocks, calls);
    expect(times.get("a")).toEqual({ startedAt: 1, endedAt: 2 });
    expect(times.get("b")).toEqual({ startedAt: 3, endedAt: undefined });
    expect(toolTimesOfRow("not json", null).size).toBe(0);
  });

  test("each time from the first source that has it", () => {
    expect(firstTimes(undefined, { startedAt: 1 }, { startedAt: 2, endedAt: 3 })).toEqual({ startedAt: 1, endedAt: 3 });
  });
});

describe("addToolCallToLastMessage", () => {
  const ROOT = testTmpDir("tool-call-times");
  let ctx: AppContext;
  beforeAll(async () => {
    setupTestDataDir(join(ROOT, "data"));
    ctx = await createTestAppContext();
  });
  afterAll(() => cleanupTestDataDir(ROOT));

  test("an id announced again keeps its first startedAt and endedAt, and takes the new args", () => {
    const sk = "topic:tool-times";
    const row = ctx.createPartialMessage(sk, "assistant");
    const first: ToolCall = { id: "t1", name: "Bash", args: {}, status: "success", startedAt: 1_000, endedAt: 4_000 };
    ctx.addToolCallToLastMessage(sk, first, { rowId: row.id });
    // The replay of a re-adoption: the same id, stamped now.
    ctx.addToolCallToLastMessage(sk, { id: "t1", name: "Bash", args: { command: "ls" }, status: "running", startedAt: 90_000 }, { rowId: row.id });
    const stored = ctx.getMessageById(row.id)!.toolCalls!;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ startedAt: 1_000, endedAt: 4_000, args: { command: "ls" } });
  });
});
