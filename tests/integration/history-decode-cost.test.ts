/**
 * What `/api/history` DECOMPRESSES to answer a page of a chat.
 *
 * `blocks` sits in SQLite as zstd, and inside it every tool call carries its
 * whole output (`detail.output`, `detail.content`, `result`). The wire never
 * sees that text - `leanMessagesForHistory` blanks it and the row fetches it
 * on first expand - but reading ONE row still means decompressing and parsing
 * all of it. Measured on this machine's DB (2026-09-30): the tail-first open
 * of `topic:0299ac2d` decompressed 1.74 MB for the 40 rows of the page, then
 * the byte budget kept 8 of them; the completion request (`limit: 0` +
 * `before`) of `topic:6b9605e5` decompressed 9.10 MB, 1.91 MB of which were
 * the tail rows the first request had already shipped and this one drops.
 *
 * So the gate counts the bytes zstd hands back, which no scheduler can move:
 * - the first page decompresses the rows it ships plus the one that broke the
 *   budget, not the whole count the client asked for;
 * - the completion decompresses the rows BEFORE the cursor, not the tail.
 * The in-row half (tool output stored inline) needs its own storage and is not
 * what this file measures.
 * @covers WIRE-09
 */
import { describe, expect, test, beforeAll, afterEach } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ContentBlock, ToolCall } from "../../shared/types";

const TEST_DATA = testTmpDir("history-decode-cost-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

/** Lean text: it survives the stripping, so it is what the byte budget sees. */
function prose(seed: string, kb: number): string {
  const line = `${seed} :: a line of an assistant answer, about as long as a real one\n`;
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

/** Tool output: stripped from the wire, still inside the stored blob. */
function output(seed: string, kb: number): string {
  const line = `${seed} :: one line of a tool output, about as long as a real one\n`;
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

const TURNS = 20;
const LEAN_KB = 60;
const OUTPUT_KB = 300;

/** `TURNS` user+assistant pairs; each assistant row = ~LEAN_KB of text + one tool of ~OUTPUT_KB. */
function seedThread(ctx: AppContext, sessionKey: string, prefix: string): void {
  const msgs: StoredMessage[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < TURNS; i++) {
    const u = `${prefix}-u${i}`;
    msgs.push({ id: u, role: "user", content: `question ${i}`, timestamp: new Date(Date.now() + i * 2000).toISOString(), parentId });
    const text = prose(`${prefix}-${i}`, LEAN_KB);
    const tc: ToolCall = { id: `${prefix}-t${i}`, name: "Bash", args: {}, status: "success", detail: { type: "shell", command: `echo ${i}`, output: output(`${prefix}-${i}`, OUTPUT_KB) } };
    const blocks: ContentBlock[] = [
      { kind: "tool", toolCall: tc } as ContentBlock,
      { kind: "text", text } as ContentBlock,
    ];
    const a = `${prefix}-a${i}`;
    msgs.push({ id: a, role: "assistant", content: text, timestamp: new Date(Date.now() + i * 2000 + 1000).toISOString(), parentId: u, blocks, endReason: i % 2 ? "done" : "stopped" });
    parentId = a;
  }
  ctx.saveLocalMessages(sessionKey, msgs);
}

/** Bytes zstd returned since the last `reset`: the decode cost of a request. */
const realDecompress = Bun.zstdDecompressSync;
let decodedBytes = 0;
function countDecodes(): void {
  decodedBytes = 0;
  (Bun as unknown as { zstdDecompressSync: typeof realDecompress }).zstdDecompressSync = ((buf: Parameters<typeof realDecompress>[0]) => {
    const out = realDecompress(buf);
    decodedBytes += out.length;
    return out;
  }) as typeof realDecompress;
}
afterEach(() => {
  (Bun as unknown as { zstdDecompressSync: typeof realDecompress }).zstdDecompressSync = realDecompress;
});

type Answer = { messages: StoredMessage[]; total: number; decoded: number };

async function historyCaller(sessionKey: string): Promise<(body: { limit: number; before?: string }) => Promise<Answer>> {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const ctx = await createTestAppContext();
  seedThread(ctx, sessionKey, sessionKey.replace(/[^a-z0-9]/gi, ""));
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: the fixture already has the local messages"); },
  });
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  return async (body) => {
    const url = new URL(`http://h${path}`);
    const req = new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    countDecodes();
    const resp = (await router(req, url, path, "POST"))!;
    const decoded = decodedBytes;
    const parsed = JSON.parse(await resp.text());
    return { messages: parsed.messages, total: parsed.total, decoded };
  };
}

/** Decompressed size of ONE assistant row of the fixture (its `blocks` JSON). */
const ROW_BYTES = (LEAN_KB + OUTPUT_KB) * 1024;
const assistantRows = (msgs: StoredMessage[]) => msgs.filter((m) => m.role === "assistant").length;

describe("decode cost of /api/history", () => {
  test("the first page decompresses the rows it ships, not the forty it was asked for", async () => {
    const ask = await historyCaller("decode:first");
    const page = await ask({ limit: 40 });
    // The fixture is fat enough for the byte budget to cut the page: without
    // this the bound below would be vacuous.
    expect(page.total).toBe(TURNS * 2);
    expect(page.messages.length).toBeLessThan(TURNS * 2);
    const shipped = assistantRows(page.messages);
    expect(shipped).toBeGreaterThan(0);
    // Rows shipped plus the one that broke the budget. Before: all TURNS
    // assistant rows (~7 MB for ~1.4 MB shipped).
    expect(page.decoded).toBeLessThan((shipped + 1.5) * ROW_BYTES);
    expect(page.decoded).toBeGreaterThan(shipped * ROW_BYTES * 0.9);
  });

  test("the completion decompresses the rows before the cursor, not the tail it already shipped", async () => {
    const ask = await historyCaller("decode:complete");
    const page = await ask({ limit: 40 });
    const oldest = page.messages[0]!.id;
    const rest = await ask({ limit: 0, before: oldest });
    // The two answers tile the thread (history-before-cursor.test.ts pins
    // that in general; here it keeps the count below honest).
    expect(rest.messages.length + page.messages.length).toBe(TURNS * 2);
    const shipped = assistantRows(rest.messages);
    // Before: every row of the thread, the tail of the first page included.
    expect(rest.decoded).toBeLessThan((shipped + 0.5) * ROW_BYTES);
    expect(rest.decoded).toBeGreaterThan(shipped * ROW_BYTES * 0.9);
  });

  test("the answers are the same rows, whole thread against the two pages", async () => {
    const ask = await historyCaller("decode:same");
    const whole = await ask({ limit: 0 });
    const page = await ask({ limit: 40 });
    const rest = await ask({ limit: 0, before: page.messages[0]!.id });
    // Deep equality, not string equality: the lean read hydrates `blocks` after
    // the other fields, so the key ORDER differs from a fat read's. The client
    // reads fields, never the order. `endReason` is in the fixture because the
    // lean read used to leave it out: the same row came back with it from the
    // whole thread and without it from the first page.
    expect([...rest.messages, ...page.messages]).toEqual(whole.messages);
  });
});
