/**
 * What `GET /api/topics/:id/messages?limit=N` PAYS for.
 *
 * The route read the WHOLE session (`SELECT *` and a parse of `blocks` and
 * `tool_calls` for every row) only to keep the last N: on the
 * `check:route-latency` bench, 3000 messages to answer with 200. Now the thread
 * is walked as a skeleton (the fat columns are not even asked of SQLite) and
 * `hydrateMessageBodies` re-reads them ONLY for the rows that go out, as
 * `/api/history` does.
 *
 * Two properties, and the second keeps the first honest:
 *
 *  1. COST: the rows that go through the decode are the window's, not the
 *     session's.
 *  2. IDENTICAL ANSWER: same messages, same `total`, same `toolCalls` (a
 *     partial's included, which `leanMessageForWire` leaves intact) as when the
 *     route read everything. A cut that changes the answer would pass the first
 *     and be a regression.
 * @covers WIRE-09
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { leanMessagesForWire } from "../../shared/lean-tool-call";
import type { ContentBlock, ToolCall } from "../../shared/types";
import type { StoredMessage } from "../../server/types";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("topic-messages-window-cost");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

const TURNS = 60;

function seed(sessionKey: string): StoredMessage[] {
  const msgs: StoredMessage[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < TURNS; i++) {
    const u = `u${i}`;
    msgs.push({ id: u, role: "user", content: `domanda ${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2)).toISOString(), parentId });
    const tc: ToolCall = { id: `t${i}`, name: "Bash", args: {}, status: "success", detail: { type: "shell", command: `echo ${i}`, output: `fatto ${i}` } };
    const blocks: ContentBlock[] = [{ kind: "tool", toolCall: tc } as ContentBlock, { kind: "text", text: `risposta ${i}` } as ContentBlock];
    const last = i === TURNS - 1;
    msgs.push({
      id: `a${i}`, role: "assistant", content: `risposta ${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2 + 1)).toISOString(),
      parentId: u, blocks, toolCalls: [tc], ...(last ? { partial: true } : {}),
    });
    parentId = `a${i}`;
  }
  void sessionKey;
  return msgs;
}

describe("GET /api/topics/:id/messages pays for the window, not the session", () => {
  test("decodes only the rows that go out and answers as before", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();

    const decoded: number[] = [];
    const realHydrate = ctx.hydrateMessageBodies;
    const fatReads: number[] = [];
    const realLoad = ctx.loadLocalMessages;
    ctx.hydrateMessageBodies = ((msgs: StoredMessage[], o?: any) => { decoded.push(msgs.length); return realHydrate(msgs, o); }) as typeof ctx.hydrateMessageBodies;
    ctx.loadLocalMessages = ((sk: string, o?: any) => {
      const r = realLoad(sk, o);
      if (!o || o.withBlocks !== false) fatReads.push(r.length);
      return r;
    }) as typeof ctx.loadLocalMessages;
    const router = createTopicsRouter(ctx);

    const now = new Date().toISOString();
    const sessionKey = "topic:window-cost";
    ctx.saveSingleTopic({ id: "window-cost", name: "window cost", slug: "window-cost", parentId: null, sessionKey, color: "blue", icon: "chat", createdAt: now, updatedAt: now, archived: false } as any);
    ctx.saveLocalMessages(sessionKey, seed(sessionKey));

    const get = async (qs: string) => {
      const url = new URL(`http://h/api/topics/window-cost/messages${qs}`);
      const res = await router(new Request(url), url, url.pathname, "GET");
      return JSON.parse(await res!.text()) as { messages: StoredMessage[]; total: number };
    };

    // The reference result is the old route's: fat read, filter, cut.
    const expected = (limit: number, offset: number) => {
      const complete = realLoad(sessionKey).filter((m) => !m.partial || (m.content && m.content.trim()));
      const sliced = offset > 0 ? complete.slice(0, Math.max(0, complete.length - offset)) : complete;
      return { messages: JSON.parse(JSON.stringify(leanMessagesForWire(sliced.slice(-limit)))), total: complete.length, topicName: "window cost" };
    };

    decoded.length = 0;
    fatReads.length = 0;
    const small = await get("?limit=5");
    expect(fatReads).toEqual([]); // no fat read of the whole session
    expect(decoded.reduce((a, b) => a + b, 0)).toBe(5); // 5 rows decoded, not 120
    expect(small).toEqual(expected(5, 0));

    for (const [limit, offset] of [[200, 0], [10, 0], [10, 7], [1, 0], [1000, 3]] as const) {
      const got = await get(`?limit=${limit}&offset=${offset}`);
      expect(got).toEqual(expected(limit, offset));
    }
    // The partial with content (the last turn) arrives with its toolCalls.
    const tail = await get("?limit=1");
    expect(tail.messages[0]?.partial).toBe(true);
    expect(tail.messages[0]?.toolCalls?.length).toBe(1);
  });

  test("alternative branches, multiple roots and empty partial: same thread as loadLocalMessages", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const now = new Date().toISOString();
    const sessionKey = "topic:window-branches";
    ctx.saveSingleTopic({ id: "window-branches", name: "branches", slug: "window-branches", parentId: null, sessionKey, color: "blue", icon: "chat", createdAt: now, updatedAt: now, archived: false } as any);
    const t = (i: number) => new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString();
    ctx.saveLocalMessages(sessionKey, [
      { id: "br", role: "user", content: "radice", timestamp: t(0), parentId: null },
      { id: "ba0", role: "assistant", content: "ramo zero", timestamp: t(1), parentId: "br", branchIndex: 0 },
      { id: "ba1", role: "assistant", content: "ramo uno", timestamp: t(2), parentId: "br", branchIndex: 1 },
      { id: "bu2", role: "user", content: "dopo il ramo uno", timestamp: t(3), parentId: "ba1" },
      { id: "bempty", role: "assistant", content: "  ", timestamp: t(4), parentId: "bu2", partial: true },
    ] as StoredMessage[]);
    const get = async (qs: string) => {
      const url = new URL(`http://h/api/topics/window-branches/messages${qs}`);
      const res = await router(new Request(url), url, url.pathname, "GET");
      return JSON.parse(await res!.text()) as { messages: StoredMessage[]; total: number };
    };
    const reference = (limit: number, offset: number) => {
      const complete = ctx.loadLocalMessages(sessionKey).filter((m) => !m.partial || (m.content && m.content.trim()));
      const sliced = offset > 0 ? complete.slice(0, Math.max(0, complete.length - offset)) : complete;
      return { messages: JSON.parse(JSON.stringify(leanMessagesForWire(sliced.slice(-limit)))), total: complete.length, topicName: "branches" };
    };
    // Default active branch (index 0): the walk does not enter branch one.
    expect(await get("?limit=50")).toEqual(reference(50, 0));
    // Active branch chosen by the person: the thread goes through branch one, and the empty partial disappears.
    ctx.db.prepare("INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES (?, ?, ?)").run("br", sessionKey, 1);
    const viaBranchOne = await get("?limit=50");
    expect(viaBranchOne).toEqual(reference(50, 0));
    expect(viaBranchOne.messages.map((m) => m.id)).toEqual(["br", "ba1", "bu2"]);
    expect(viaBranchOne.messages.find((m) => m.id === "ba1")?.siblingCount).toBe(2);
    for (const [limit, offset] of [[2, 0], [2, 1], [1, 5], [0, 0]] as const) {
      expect(await get(`?limit=${limit}&offset=${offset}`)).toEqual(reference(limit, offset));
    }
  });
});

describe("the window's partial row uses the thread's own rule for toolCalls", () => {
  test("topics.ts imports restoreToolCallsFromBlocks from utils and keeps no copy of it", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const src = readFileSync(join(import.meta.dir, "..", "..", "server", "routes", "topics.ts"), "utf8");
    expect(src).toContain('import { restoreToolCallsFromBlocks } from "../utils"');
    const at = src.indexOf("loadThreadWindow(topic.sessionKey");
    const block = src.slice(at, at + 1500);
    expect(block).toContain("restoreToolCallsFromBlocks(m)");
    expect(block).not.toContain('kind === "tool"');
  });
});
