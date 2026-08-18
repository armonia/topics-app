/**
 * Loading a thread WITHOUT the two fat columns.
 *
 * `messages` is 97% of this database, and inside `messages` 98% of the bytes
 * sit in `blocks` and `tool_calls` (353 MB and 220 MB against 13 MB of text, on
 * this machine as of 2026-08-14). Context assembly, which runs on EVERY turn of
 * every agent, reads nothing out of those two columns, and until 2026-08-14 it
 * paid for them anyway: `withBlocks: false` skipped the parse of `blocks` but
 * not the one of `tool_calls`, and the bytes of both came out of SQLite only to
 * be thrown away.
 *
 * Measured on a copy of the real DB, topic 6b99e9cf, 118 rows, median of 7:
 *
 *   SELECT *                                  6.1 ms
 *   SELECT * + JSON.parse of the tool_calls  14.5 ms
 *   SELECT without blocks/tool_calls          0.5 ms
 *
 * What is tested here is the only thing a gate can test without a stopwatch:
 * that the lean version says EXACTLY the same things as the full one, minus
 * what the caller said it did not want. Time is measured, not gated: a
 * threshold in milliseconds on a shared machine would be noise.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ToolCall, ContentBlock } from "../../shared/types";

const TEST_DATA = testTmpDir("thread-lean-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

function seed(ctx: AppContext, sessionKey: string, p: string): void {
  const tc: ToolCall = {
    id: `${p}-tc1`, name: "Bash", args: { command: "echo hello" }, status: "success",
    result: "hello", detail: { type: "shell", command: "echo hello", output: "hello" },
    startedAt: 1, endedAt: 2,
  };
  const blocks: ContentBlock[] = [
    { kind: "text", text: "here" } as ContentBlock,
    { kind: "tool", toolCall: tc } as ContentBlock,
  ];
  ctx.saveLocalMessages(sessionKey, [
    { id: `${p}-u1`, role: "user", content: "question", timestamp: new Date(1).toISOString() },
    {
      id: `${p}-a1`, role: "assistant", content: "answer", timestamp: new Date(2).toISOString(),
      parentId: `${p}-u1`, blocks, toolCalls: [tc], thinking: "reasoning",
      media: ["/tmp/x.png"], latencyMs: 42, usagePromptTokens: 7, usageCompletionTokens: 9,
      costCents: 3, model: "claude-opus-5", cacheReadTokens: 5,
    },
  ]);
}

describe("loadLocalMessages: how much of a message gets loaded", () => {
  test("by default both the blocks and the tool calls arrive", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-full", "lf");
    const [, a] = ctx.loadLocalMessages("topic:lean-full");
    expect(a.blocks?.length).toBe(2);
    expect(a.toolCalls?.length).toBe(1);
  });

  test("withBlocks:false drops the blocks and LEAVES the tool calls (unchanged behaviour)", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-noblocks", "lb");
    const [, a] = ctx.loadLocalMessages("topic:lean-noblocks", { withBlocks: false });
    expect(a.blocks).toBeUndefined();
    expect(a.toolCalls?.length).toBe(1);
  });

  test("with BOTH set to false they both disappear, and nothing else changes", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-both", "lbo");
    const full = ctx.loadLocalMessages("topic:lean-both");
    const lean = ctx.loadLocalMessages("topic:lean-both", { withBlocks: false, withToolCalls: false });

    expect(lean.length).toBe(full.length);
    for (let i = 0; i < lean.length; i++) {
      expect(lean[i].blocks).toBeUndefined();
      expect(lean[i].toolCalls).toBeUndefined();
      // Everything ELSE must be identical: it is the only thing that makes the
      // lean version substitutable for the full one for whoever does not read
      // the two columns. A field lost here would be a maimed assembled turn.
      const withoutFat = (x: StoredMessage) => {
        const { blocks: _b, toolCalls: _t, ...rest } = x;
        return rest;
      };
      expect(withoutFat(lean[i])).toEqual(withoutFat(full[i]));
    }
  });

  test("the active branch is the SAME: the lean version does not change which messages come back", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-branch", "lbr");
    const full = ctx.loadLocalMessages("topic:lean-branch").map((m) => m.id);
    const lean = ctx.loadLocalMessages("topic:lean-branch", { withBlocks: false, withToolCalls: false }).map((m) => m.id);
    expect(lean).toEqual(full);
  });

  test("withToolCalls:false on its own does NOT enable the lean read: the blocks stay", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-onlytc", "lo");
    const [, a] = ctx.loadLocalMessages("topic:lean-onlytc", { withToolCalls: false });
    expect(a.blocks?.length).toBe(2);
  });
});
