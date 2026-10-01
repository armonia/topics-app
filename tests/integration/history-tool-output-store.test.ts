/**
 * Tool call output out of the message row, end to end on the real store and
 * the real routes (server/lib/tool-output-store.ts).
 *
 * A thread is written the old way (whole rows, closed by a flag flip as the
 * sweepers do), every reader is asked for it, the backfill moves the output
 * out, and every reader is asked again. The answers must be the same, field
 * for field, and the history page must stop decompressing the output. Then
 * the new way: the same thread rewritten through `saveLocalMessages` sheds its
 * output at the write, and reads the same.
 *
 * The readers are the ones `grep` finds for tool output read off the DB:
 * - the history page (`/api/history`, stub read) and the tool detail route
 *   (`/api/messages/:id/tool/:id/detail`, the one read of a page's output);
 * - the full reads everything else goes through: `loadLocalMessages`,
 *   `loadActiveThread`, `getMessageById`, `hydrateMessageBodies`;
 * - the model's history after a restart (`nativeHistorySource` +
 *   `historyFromPersistedThread`, providers/native/history-rehydrate.ts);
 * - Regenerate's evidence (`formatRegenerationEvidence` on `getMessageById`);
 * - the MCP transcript read (`GET /api/topics/:id/messages`, read by
 *   `read_chat_messages`) and one row of it (`/messages/:messageId`);
 * - a fork (`POST /api/topics/:id/fork`, lib/chat-fork.ts), whose copies get
 *   ids of their own and must carry the output with them.
 * Search (`content LIKE`), export (the client's `content`) and compaction
 * markers read no tool output at all.
 * @covers WIRE-09
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage, Topic } from "../../server/types";
import type { ContentBlock, ToolCall } from "../../shared/types";
import { backfillToolOutputsTick, readToolOutputs } from "../../server/lib/tool-output-store";
import { nativeHistorySource } from "../../server/providers/native/history-source";
import { historyFromPersistedThread } from "../../server/providers/native/history-rehydrate";
import { formatRegenerationEvidence } from "../../server/routes/regenerate-evidence";
import { callReadChatMessages } from "../../server/mcp/topics-mcp-server";

const ROOT = testTmpDir("history-tool-output-store");
let ctx: AppContext;

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  ctx = await createTestAppContext();
});
afterAll(async () => { await cleanupTestDataDir(ROOT); });

const TURNS = 12;
const LEAN_KB = 8;
const OUTPUT_KB = 120;

function text(seed: string, kb: number): string {
  const line = `${seed} :: a line about as long as a real one\n`;
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

/** A thread with every kind of call the store treats differently. */
function thread(prefix: string): StoredMessage[] {
  const msgs: StoredMessage[] = [];
  let parentId: string | null = null;
  const t0 = Date.parse("2026-09-30T10:00:00.000Z");
  for (let i = 0; i < TURNS; i++) {
    const u = `${prefix}-u${i}`;
    msgs.push({ id: u, role: "user", content: `question ${i}`, timestamp: new Date(t0 + i * 2000).toISOString(), parentId });
    const out = text(`${prefix}-${i}`, OUTPUT_KB);
    const calls: ToolCall[] = [
      // Moves: typed detail, big output, and an older row's duplicate result.
      { id: `${prefix}-sh${i}`, name: "Bash", args: { command: `echo ${i}`, description: `step ${i}` }, status: "success", result: out, detail: { type: "shell", command: `echo ${i}`, output: out } } as ToolCall,
      // Moves: a Read's content.
      { id: `${prefix}-rd${i}`, name: "Read", args: { file_path: `/f${i}` }, status: "success", detail: { type: "read", filePath: `/f${i}`, content: text(`read-${i}`, 4) } } as ToolCall,
      // Stays: small.
      { id: `${prefix}-sm${i}`, name: "Bash", args: { command: "true" }, status: "success", detail: { type: "shell", command: "true", output: "ok" } } as ToolCall,
      // Its content moves; its result of its own stays, the page ships it.
      { id: `${prefix}-own${i}`, name: "Write", args: { file_path: `/w${i}` }, status: "success", result: `wrote /w${i}`, detail: { type: "write", filePath: `/w${i}`, content: text(`write-${i}`, 3) } } as ToolCall,
    ];
    const blocks: ContentBlock[] = [
      ...calls.map((toolCall) => ({ kind: "tool", toolCall }) as ContentBlock),
      { kind: "text", text: text(`${prefix}-answer-${i}`, LEAN_KB) } as ContentBlock,
    ];
    const a = `${prefix}-a${i}`;
    msgs.push({ id: a, role: "assistant", content: `answer ${i}`, timestamp: new Date(t0 + i * 2000 + 1000).toISOString(), parentId: u, blocks, endReason: "done" });
    parentId = a;
  }
  return msgs;
}

/** Written whole, as before the split existed: open rows, then closed by a flag flip. */
function seedWhole(sessionKey: string, prefix: string): Topic {
  const now = new Date().toISOString();
  const id = `${prefix}-topic`;
  const topic: Topic = { id, name: prefix, slug: prefix, parentId: null, links: [], sessionKey, color: "#123456", icon: "MessageSquare", createdAt: now, updatedAt: now, archived: false };
  ctx.saveSingleTopic(topic);
  ctx.saveLocalMessages(sessionKey, thread(prefix).map((m) => ({ ...m, partial: true })));
  ctx.db.run("UPDATE messages SET partial = 0 WHERE session_key = ?", [sessionKey]);
  return topic;
}

/** Tool calls of the session whose output is stored out of the row. */
const sideRows = (sessionKey: string) => (ctx.db.query(
  "SELECT o.message_id AS id FROM message_tool_outputs o JOIN messages m ON m.id = o.message_id WHERE m.session_key = ?",
).all(sessionKey) as { id: string }[]).reduce((n, r) => n + readToolOutputs(ctx.db, r.id).size, 0);

/** Bytes zstd hands back while `fn` runs. */
async function decoded<T>(fn: () => Promise<T>): Promise<{ value: T; bytes: number }> {
  const real = Bun.zstdDecompressSync;
  let bytes = 0;
  (Bun as unknown as { zstdDecompressSync: typeof real }).zstdDecompressSync = ((buf: Parameters<typeof real>[0]) => {
    const out = real(buf);
    bytes += out.length;
    return out;
  }) as typeof real;
  try {
    return { value: await fn(), bytes };
  } finally {
    (Bun as unknown as { zstdDecompressSync: typeof real }).zstdDecompressSync = real;
  }
}

async function history(sessionKey: string, body: { limit: number; before?: string }) {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: the rows are local"); },
  });
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  const url = new URL(`http://h${path}`);
  const req = new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return (await (await router(req, url, path, "POST"))!.json()) as { messages: StoredMessage[]; total: number };
}

async function toolDetail(messageId: string, toolCallId: string) {
  const { createToolDetailRouter } = await import("../../server/routes/history");
  const router = createToolDetailRouter(ctx);
  const path = `/api/messages/${encodeURIComponent(messageId)}/tool/${encodeURIComponent(toolCallId)}/detail`;
  const url = new URL(`http://h${path}`);
  return (await (await router(new Request(url), url, path, "GET"))!.json()) as { detail: unknown; args: unknown };
}

async function topicsRoute(path: string) {
  const { createTopicsRouter } = await import("../../server/routes/topics");
  const router = createTopicsRouter(ctx);
  const url = new URL(`http://h${path}`);
  const resp = await router(new Request(url), url, url.pathname, "GET");
  return (await resp!.json()) as { messages?: StoredMessage[]; message?: StoredMessage };
}

/** Everything every reader answers about a thread. */
async function readAll(topic: Topic) {
  const sk = topic.sessionKey;
  const whole = await history(sk, { limit: 0 });
  const first = await history(sk, { limit: 6 });
  const rest = await history(sk, { limit: 0, before: first.messages[0]!.id });
  const assistantIds = whole.messages.filter((m) => m.role === "assistant").map((m) => m.id);
  const details: Record<string, unknown> = {};
  for (const m of ctx.loadLocalMessages(sk)) {
    for (const b of m.blocks ?? []) if (b.kind === "tool") details[`${m.id}/${b.toolCall.id}`] = await toolDetail(m.id, b.toolCall.id);
  }
  const lean = ctx.loadLocalMessages(sk, { withBlocks: false, withToolCalls: false });
  const readChat = await callReadChatMessages(
    { baseUrl: "http://h", sessionKey: "topic:reader" } as never,
    { topic_id: topic.id, limit: 200 },
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const { createTopicsRouter } = await import("../../server/routes/topics");
      const router = createTopicsRouter(ctx);
      const req = new Request(input as string, init);
      const url = new URL(req.url);
      return (await router(req, url, url.pathname, req.method)) ?? new Response("not found", { status: 404 });
    }) as typeof fetch,
  );
  return {
    history: { whole: whole.messages, first: first.messages, rest: rest.messages },
    details,
    loadLocalMessages: ctx.loadLocalMessages(sk),
    loadActiveThread: ctx.loadActiveThread(sk, { withBlocks: true }),
    getMessageById: assistantIds.map((id) => ctx.getMessageById(id)),
    hydrateMessageBodies: ctx.hydrateMessageBodies(lean),
    model: historyFromPersistedThread(nativeHistorySource(ctx, sk)),
    evidence: assistantIds.map((id) => formatRegenerationEvidence(ctx.getMessageById(id)!.toolCalls)),
    mcpMessages: (await topicsRoute(`/api/topics/${topic.id}/messages?limit=200`)).messages,
    mcpRow: (await topicsRoute(`/api/topics/${topic.id}/messages/${assistantIds[3]}`)).message,
    readChat,
  };
}

describe("tool output out of the row", () => {
  test("the backfill changes no reader's answer, and the page stops decompressing the output", async () => {
    const topic = seedWhole("topic:tos-backfill", "tb");
    const before = await readAll(topic);
    const pageBefore = await decoded(() => history(topic.sessionKey, { limit: 6 }));
    expect(sideRows(topic.sessionKey)).toBe(0);

    while (!backfillToolOutputsTick(ctx.db, { maxRows: 5, maxMs: 1000 }).done) { /* drain */ }
    // Three moving calls per turn: the shell, the Read, and the Write's content
    // (its own `result` stays in the row); the small one stays whole.
    expect(sideRows(topic.sessionKey)).toBe(TURNS * 3);

    const after = await readAll(topic);
    expect(after).toEqual(before);
    // The model sees the output of the latest turn (older ones are evicted
    // for room by design), not the "nothing recorded" placeholder.
    expect(JSON.stringify(after.model)).toContain(JSON.stringify(text(`tb-${TURNS - 1}`, OUTPUT_KB).slice(0, 200)).slice(1, -1));

    const pageAfter = await decoded(() => history(topic.sessionKey, { limit: 6 }));
    expect(pageAfter.value).toEqual(pageBefore.value);
    const shippedRows = pageAfter.value.messages.filter((m) => m.role === "assistant").length;
    // Before: every shipped row decompressed its ~124 KB of output. After:
    // the lean text and the stubs only.
    expect(pageBefore.bytes).toBeGreaterThan(shippedRows * OUTPUT_KB * 1024);
    expect(pageAfter.bytes).toBeLessThan(shippedRows * (LEAN_KB + 6) * 1024);
  });

  test("a closed row written now sheds its output at the write and reads the same", async () => {
    const topic = seedWhole("topic:tos-write", "tw");
    const before = await readAll(topic);
    // A full read handed back to the writer: the path of a fork, an import,
    // a session replaced whole.
    ctx.saveLocalMessages(topic.sessionKey, ctx.loadLocalMessages(topic.sessionKey));
    expect(sideRows(topic.sessionKey)).toBe(TURNS * 3);
    expect(await readAll(topic)).toEqual(before);
  });

  test("the turn's closing write splits; while the row is open nothing leaves it", async () => {
    const sk = "topic:tos-turn";
    ctx.saveLocalMessages(sk, [{ id: "tt-u", role: "user", content: "go", timestamp: new Date().toISOString() }]);
    const row = ctx.createPartialMessage(sk, "assistant");
    const blocks = thread("tt")[1]!.blocks!;
    ctx.updateLastMessage(sk, { blocks }, { rowId: row.id });
    expect(sideRows(sk)).toBe(0);
    ctx.updateLastMessage(sk, { content: "answer", blocks, partial: undefined, streamedAt: undefined, endReason: "done" }, { rowId: row.id });
    expect(sideRows(sk)).toBe(3);
    const read = ctx.getMessageById(row.id)!;
    expect(read.blocks).toEqual(blocks.map((b) => (b.kind === "tool" && (b.toolCall as { result?: string }).result === (b.toolCall.detail as { output?: string }).output
      // The duplicate result never reaches the disk (leanBlocks), as before.
      ? { ...b, toolCall: (({ result: _r, ...rest }) => rest)(b.toolCall as ToolCall & { result?: string }) }
      : b)));
  });

  test("a fork carries the output to its own rows", async () => {
    const parent = seedWhole("topic:tos-fork", "tf");
    ctx.db.run("UPDATE message_tool_outputs_backfill SET after_id = '', finished_at = NULL");
    while (!backfillToolOutputsTick(ctx.db, { maxRows: 50, maxMs: 1000 }).done) { /* drain */ }
    const { createForkRouter } = await import("../../server/routes/fork");
    const router = createForkRouter(ctx, { resolveProvider: () => ({ name: "topics" }) as never });
    const path = `/api/topics/${parent.id}/fork`;
    const url = new URL(`http://h${path}`);
    const resp = await router(new Request(url, { method: "POST", body: JSON.stringify({ name: "branch" }) }), url, path, "POST");
    expect(resp?.status).toBe(201);
    const topic = (await resp!.json()) as Topic;
    const strip = (ms: StoredMessage[]) => ms.map(({ id: _i, parentId: _p, ...rest }) => rest);
    expect(strip(ctx.loadLocalMessages(topic.sessionKey))).toEqual(strip(ctx.loadLocalMessages(parent.sessionKey)));
    expect(sideRows(topic.sessionKey)).toBe(TURNS * 3);
    // The parent's text is not shared: deleting the parent leaves the fork whole.
    ctx.db.run("DELETE FROM messages WHERE session_key = ?", [parent.sessionKey]);
    expect(sideRows(parent.sessionKey)).toBe(0);
    const forked = ctx.loadLocalMessages(topic.sessionKey);
    const shell7 = forked.flatMap((m) => m.blocks ?? []).find((b) => b.kind === "tool" && b.toolCall.id === "tf-sh7");
    expect(shell7?.kind === "tool" && (shell7.toolCall.detail as { output?: string }).output).toBe(text("tf-7", OUTPUT_KB));
  });
});
