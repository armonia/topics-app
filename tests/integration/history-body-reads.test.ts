/**
 * The second pass of a lean history read: how the stored bodies come back.
 *
 * - `tool_calls` is not written when a row has `blocks`, so a closed row's
 *   tool calls come back out of its tool blocks, while a partial row is left
 *   as it is (the wire keeps a partial whole, a rebuilt copy would double the
 *   in-flight turn).
 * - The byte-budgeted first page decodes row by row from the tail, but it
 *   reads the stored columns of the whole page in ONE statement, not one
 *   SELECT per row (40 for a light page before).
 * @covers WIRE-09
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ContentBlock, ToolCall } from "../../shared/types";

const TEST_DATA = testTmpDir("history-body-reads-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

function toolTurn(prefix: string, i: number, parentId: string | null, partial = false): StoredMessage[] {
  const u = `${prefix}-u${i}`;
  const tc: ToolCall = { id: `${prefix}-t${i}`, name: "Bash", args: {}, status: "success", detail: { type: "shell", command: `echo ${i}`, output: `out ${i}` } };
  const blocks: ContentBlock[] = [
    { kind: "tool", toolCall: tc } as ContentBlock,
    { kind: "text", text: `answer ${i}` } as ContentBlock,
  ];
  const t = Date.now() + i * 2000;
  return [
    { id: u, role: "user", content: `question ${i}`, timestamp: new Date(t).toISOString(), parentId },
    { id: `${prefix}-a${i}`, role: "assistant", content: `answer ${i}`, timestamp: new Date(t + 1000).toISOString(), parentId: u, blocks, ...(partial ? { partial: true } : {}) },
  ];
}

/** The rows as the lean walk hands them over: no `blocks`, no `toolCalls`. */
function lean(ctx: AppContext, sessionKey: string): StoredMessage[] {
  return ctx.loadLocalMessages(sessionKey, { withBlocks: false, withToolCalls: false });
}

describe("hydrating message bodies", () => {
  test("a closed row gets its tool calls back out of its tool blocks", async () => {
    const ctx = await createTestAppContext();
    ctx.saveLocalMessages("topic:bodies-closed", toolTurn("closed", 0, null));
    const rows = lean(ctx, "topic:bodies-closed");
    const assistant = rows.find((m) => m.role === "assistant")!;
    expect(assistant.blocks).toBeUndefined();
    expect(assistant.toolCalls).toBeUndefined();

    ctx.hydrateMessageBodies(rows);

    expect(assistant.blocks?.length).toBe(2);
    expect(assistant.toolCalls?.map((t) => t.id)).toEqual(["closed-t0"]);
    // The same objects as inside the blocks, not a copy.
    expect(assistant.toolCalls?.[0]).toBe((assistant.blocks![0] as { toolCall: ToolCall }).toolCall);
  });

  test("a partial row keeps its blocks and gets no rebuilt tool calls", async () => {
    const ctx = await createTestAppContext();
    ctx.saveLocalMessages("topic:bodies-partial", toolTurn("partial", 0, null, true));
    const rows = lean(ctx, "topic:bodies-partial");
    const assistant = rows.find((m) => m.role === "assistant")!;
    expect(assistant.partial).toBe(true);

    ctx.hydrateMessageBodies(rows);

    expect(assistant.blocks?.length).toBe(2);
    expect(assistant.toolCalls).toBeUndefined();
  });
});

describe("the first page of /api/history", () => {
  test("reads the bodies of a light page in one statement", async () => {
    const { createHistoryRouter } = await import("../../server/routes/history");
    const ctx = await createTestAppContext();
    const sessionKey = "topic:bodies-one-read";
    const msgs: StoredMessage[] = [];
    let parentId: string | null = null;
    for (let i = 0; i < 10; i++) {
      const turn = toolTurn("oneread", i, parentId);
      msgs.push(...turn);
      parentId = turn[1]!.id;
    }
    ctx.saveLocalMessages(sessionKey, msgs);

    const bodyReads: string[] = [];
    const realQuery = ctx.db.query.bind(ctx.db);
    ctx.db.query = ((sql: string) => {
      if (/SELECT id, blocks, tool_calls FROM messages WHERE id IN/.test(sql)) bodyReads.push(sql);
      return realQuery(sql);
    }) as typeof ctx.db.query;

    const router = createHistoryRouter(ctx, {
      matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
      providerForSessionKey: () => { throw new Error("no provider: the fixture already has the local messages"); },
    });
    const path = `/api/history/${encodeURIComponent(sessionKey)}`;
    const url = new URL(`http://h${path}?limit=40`);
    const resp = (await router(new Request(url), url, path, "GET"))!;
    const body = JSON.parse(await resp.text()) as { messages: StoredMessage[]; total: number };
    ctx.db.query = realQuery;

    // The page is light: every row fits the byte budget and ships hydrated.
    expect(body.total).toBe(20);
    expect(body.messages).toHaveLength(20);
    expect(body.messages.filter((m) => m.blocks?.length === 2)).toHaveLength(10);
    // Before: one SELECT per row, 20 here.
    expect(bodyReads).toHaveLength(1);
  });
});
