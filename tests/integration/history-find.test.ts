/**
 * POST /api/history-find on the real store: find inside one conversation,
 * tool outputs moved to `message_tool_outputs` included (CHAT-FIND-01).
 *
 * @covers CHAT-FIND-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage, Topic } from "../../server/types";
import type { ContentBlock, ToolCall } from "../../shared/types";
import { backfillToolOutputsTick, readToolOutputs } from "../../server/lib/tool-output-store";
import { isGuestAllowedPath } from "../../server/lib/grants";
import { CHAT_FIND_MAX_HITS } from "../../shared/chat-find";

const ROOT = testTmpDir("history-find");
let ctx: AppContext;

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  ctx = await createTestAppContext();
});
afterAll(async () => { await cleanupTestDataDir(ROOT); });

/** Big enough to be moved out of the row by the backfill. */
function bigOutput(marker: string): string {
  return `${"a line of ordinary command output, nothing to see\n".repeat(400)}cat: /etc/missing: ${marker}\n`;
}

function seed(sessionKey: string, prefix: string, opts: { outputMarker?: string; textRepeat?: { word: string; n: number } } = {}): Topic {
  const now = new Date().toISOString();
  const topic: Topic = { id: `${prefix}-topic`, name: prefix, slug: prefix, parentId: null, links: [], sessionKey, color: "#123456", icon: "MessageSquare", createdAt: now, updatedAt: now, archived: false };
  ctx.saveSingleTopic(topic);
  const t0 = Date.parse("2026-10-01T10:00:00.000Z");
  const msgs: StoredMessage[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < 6; i++) {
    const u = `${prefix}-u${i}`;
    msgs.push({ id: u, role: "user", content: `question ${i}`, timestamp: new Date(t0 + i * 2000).toISOString(), parentId });
    const calls: ToolCall[] = [{
      id: `${prefix}-sh${i}`, name: "Bash", args: { command: `cat /etc/missing-${i}` }, status: "success",
      detail: { type: "shell", command: `cat /etc/missing-${i}`, output: i === 2 && opts.outputMarker ? bigOutput(opts.outputMarker) : bigOutput("noise") },
    } as ToolCall];
    const text = opts.textRepeat && i === 5 ? `${opts.textRepeat.word} `.repeat(opts.textRepeat.n) : `answer ${i}`;
    const blocks: ContentBlock[] = [...calls.map((toolCall) => ({ kind: "tool", toolCall }) as ContentBlock), { kind: "text", text } as ContentBlock];
    const a = `${prefix}-a${i}`;
    msgs.push({ id: a, role: "assistant", content: text, timestamp: new Date(t0 + i * 2000 + 1000).toISOString(), parentId: u, blocks, endReason: "done" });
    parentId = a;
  }
  // Written whole and closed by a flag flip, then the backfill moves the
  // outputs out of the row: exactly the state of an old chat on disk.
  ctx.saveLocalMessages(sessionKey, msgs.map((m) => ({ ...m, partial: true })));
  ctx.db.run("UPDATE messages SET partial = 0 WHERE session_key = ?", [sessionKey]);
  while (!backfillToolOutputsTick(ctx.db, { maxRows: 50, maxMs: 1000 }).done) { /* drain */ }
  return topic;
}

async function find(body: Record<string, unknown>) {
  const { createHistoryFindRouter } = await import("../../server/routes/history");
  const router = createHistoryFindRouter(ctx);
  const path = "/api/history-find";
  const url = new URL(`http://h${path}`);
  const req = new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const resp = await router(req, url, path, "POST");
  return { status: resp!.status, json: (await resp!.json()) as { total: number; hits: Array<{ messageId: string; part: string; toolCallId?: string; offset: number }>; truncated: boolean } };
}

async function historyPage(sessionKey: string) {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: the rows are local"); },
  });
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  const url = new URL(`http://h${path}`);
  const req = new Request(url, { method: "POST", body: JSON.stringify({ limit: 0 }), headers: { "content-type": "application/json" } });
  return (await (await router(req, url, path, "POST"))!.text());
}

describe("POST /api/history-find", () => {
  test("a word only in a tool output stored apart is found, with its toolCallId", async () => {
    seed("topic:find-a", "fa", { outputMarker: "ENOENT_ZIBALDONE" });
    const moved = ctx.db.query("SELECT o.message_id AS id FROM message_tool_outputs o JOIN messages m ON m.id = o.message_id WHERE m.session_key = ?").all("topic:find-a") as { id: string }[];
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.some((r) => readToolOutputs(ctx.db, r.id).size > 0)).toBe(true);
    // The page the client gets does NOT carry it: that is why the client cannot find it alone.
    expect(await historyPage("topic:find-a")).not.toContain("ENOENT_ZIBALDONE");

    const r = await find({ sessionKey: "topic:find-a", query: "enoent_zibaldone", matchCase: false });
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(1);
    expect(r.json.hits).toEqual([{ messageId: "fa-a2", part: "tool", toolCallId: "fa-sh2", offset: expect.any(Number) }]);
  });

  test("a word of another session does not answer", async () => {
    seed("topic:find-b", "fb", { outputMarker: "ONLY_IN_B" });
    const r = await find({ sessionKey: "topic:find-a", query: "ONLY_IN_B", matchCase: true });
    expect(r.json.total).toBe(0);
    expect(r.json.hits).toEqual([]);
  });

  test("total is exact and truncated past the cap", async () => {
    seed("topic:find-c", "fc", { textRepeat: { word: "deploy", n: CHAT_FIND_MAX_HITS + 7 } });
    const r = await find({ sessionKey: "topic:find-c", query: "deploy", matchCase: false });
    expect(r.json.total).toBe(CHAT_FIND_MAX_HITS + 7);
    expect(r.json.hits.length).toBe(CHAT_FIND_MAX_HITS);
    expect(r.json.truncated).toBe(true);
  });

  test("an empty query finds nothing, a missing session key is refused", async () => {
    expect((await find({ sessionKey: "topic:find-a", query: "" })).json.total).toBe(0);
    expect((await find({ query: "x" })).status).toBe(400);
  });

  test("a guest does not get in: the route is outside the guest allowlist", () => {
    expect(isGuestAllowedPath("/api/history-find")).toBe(false);
  });
});
