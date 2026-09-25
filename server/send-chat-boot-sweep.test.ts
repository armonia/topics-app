/**
 * A SEND WAITED ACROSS A SERVER THAT DIED IS TOLD THE TURN WAS CUT, NOT HANDED THE HALF.
 * @covers CHAT-STREAM-01, CHAT-INT-01
 *
 * From the round-3 review of card 63e01ac0: the process dies without a clean
 * shutdown (SIGKILL, crash) while a turn writes prose; send_chat_message rides
 * the restart out; at boot `runBootPartialSweep` closes the turn's row with
 * `partial = 0` and puts its notice in a NEW row, so the row read by id looked
 * like a finished answer and the half came back as the reply. The row stays as
 * the sweep leaves it (one notice for the person, no second one on the row,
 * nothing the resume could take for a cut of ours): the tool reads the close
 * from the missing `latency_ms`, which only a turn's own completion writes.
 * The boot order is replayed on the real database: the sweep, the orphan tools
 * of a dead child, the repair of mute turns; then the real by-id route answers.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase } from "./db";
import { createAppContext } from "./utils";
import { createTopicsRouter } from "./routes/topics";
import { RESTART_INTERRUPTED_MARKER, runBootPartialSweep } from "./lib/boot-partial-sweep";
import { bonificaTurniMuti } from "./lib/verdetto-turno-interrotto";
import { finalizeOrphanTool } from "./lib/orphan-tool-sweep";
import { decodeCol, encodeCol } from "../shared/message-blob";
import { callReadChatMessages, callSendChatMessage, RESTART_NOTICE_OPENING } from "./mcp/topics-mcp-server";
import type { AppContext, Topic } from "./types";

const DATA_DIR_BEFORE = process.env.DATA_DIR;
let tmpRoot: string;
let ctx: AppContext;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "send-chat-boot-sweep-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.OPENCLAW_DIR = join(tmpRoot, "openclaw");
  ctx = createAppContext(tmpRoot);
});
afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (DATA_DIR_BEFORE === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = DATA_DIR_BEFORE;
});

const HALF = "Ecco la prima meta' della risposta, ";

function turnCutMidway(tid: string, withRunningTool: boolean) {
  const sessionKey = `topic:${tid}`;
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false } as Topic);
  ctx.appendLocalMessage(sessionKey, "user", "ping");
  const partial = ctx.createPartialMessage(sessionKey, "assistant");
  // What the route had saved when the process died.
  ctx.updateLastMessage(sessionKey, { content: HALF }, { rowId: partial.id } as never);
  if (withRunningTool) {
    const tc = { id: "tc1", name: "Bash", args: { command: "sleep 600" }, status: "running", startedAt: Date.now() };
    ctx.addToolCallToLastMessage(sessionKey, tc as never, { rowId: partial.id });
    ctx.updateLastMessage(sessionKey, { blocks: [{ kind: "text", text: HALF }, { kind: "tool", toolCall: tc }] as never }, { rowId: partial.id } as never);
  }
  return partial.id;
}

/** The server as the MCP bridge sees it: dead for `downReads` reads, then booted and serving the real routes. */
function serverThatDiesAndBoots(tid: string, rowId: string, downReads: number): typeof fetch {
  const router = createTopicsRouter(ctx);
  let reads = 0;
  let booted = false;
  const cutStream = `data: ${JSON.stringify({ turn: { messageId: rowId } })}\n\n: ping\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: HALF } }] })}\n\n`;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/chat") {
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(cutStream)); c.close(); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (u.pathname !== `/api/topics/${tid}`) {
      if (++reads <= downReads) throw new TypeError("Unable to connect. Is the computer able to access the url?");
      if (!booted) {
        booted = true;
        const db = getDatabase();
        runBootPartialSweep(db as never, { listConfirmed: true, liveSessions: new Set() });
        // Pass 1 of finalizeOrphanedRunningTools (server.ts): a dead child's running tools are closed as interrupted.
        for (const r of db.query("SELECT id, tool_calls, blocks FROM messages WHERE partial = 0 AND (tool_calls IS NOT NULL OR blocks IS NOT NULL)").all() as Array<{ id: string; tool_calls: unknown; blocks: unknown }>) {
          let tc = decodeCol(r.tool_calls), bl = decodeCol(r.blocks), changed = false;
          if (tc) { const a = JSON.parse(tc); for (const t of a) if (finalizeOrphanTool(t, { childAlive: false, now: Date.now() })) changed = true; tc = JSON.stringify(a); }
          if (bl) { const a = JSON.parse(bl); for (const b of a) if (b?.kind === "tool" && finalizeOrphanTool(b.toolCall, { childAlive: false, now: Date.now() })) changed = true; bl = JSON.stringify(a); }
          if (changed) db.run("UPDATE messages SET tool_calls = ?, blocks = ? WHERE id = ?", [encodeCol(tc) ?? null, encodeCol(bl) ?? null, r.id]);
        }
        bonificaTurniMuti(db as never, "Turno interrotto prima di una risposta finale");
      }
    }
    return (await router(new Request(u.toString(), { method: init?.method ?? "GET" }), u, u.pathname, init?.method ?? "GET"))!;
  }) as typeof fetch;
}

const send = (tid: string, fetchImpl: typeof fetch) => callSendChatMessage(
  { baseUrl: "http://x", sessionKey: "topic:caller" },
  { topic_id: tid, message: "ping" },
  fetchImpl,
  { pollMs: 5, maxWaitMs: 5_000, unreachableMs: 2_000 },
);

describe("send_chat_message across a server that died and booted", () => {
  test("died while the model wrote prose, no tool running: closed before it finished, the half as what it had written", async () => {
    const rowId = turnCutMidway("boot-prose", false);
    await expect(send("boot-prose", serverThatDiesAndBoots("boot-prose", rowId, 3)))
      .rejects.toThrow(`stream interrupted, and the turn was closed before it finished (a restart, a stop or the watchdog). What it had written: ${JSON.stringify(HALF.trim())}. Before sending it again`);
  });

  test("died during a silent tool: the interrupted tool's verdict, written once", async () => {
    const rowId = turnCutMidway("boot-tool", true);
    await expect(send("boot-tool", serverThatDiesAndBoots("boot-tool", rowId, 3)))
      .rejects.toThrow(/stream interrupted, and the turn then ended badly: Turno interrotto prima di una risposta finale\. What it had written/);
    const row = ctx.getMessageById(rowId)!;
    expect(row.blocks!.filter((b) => b.kind === "error")).toHaveLength(1);
  });

  test("died before anything was saved: nothing written, a warning against resending, the row left hidden", async () => {
    const tid = "boot-empty";
    const sessionKey = `topic:${tid}`;
    const now = new Date().toISOString();
    ctx.saveSingleTopic({ id: tid, name: tid, slug: tid, parentId: null, links: [], sessionKey, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false } as Topic);
    ctx.appendLocalMessage(sessionKey, "user", "ping");
    const rowId = ctx.createPartialMessage(sessionKey, "assistant").id;
    await expect(send(tid, serverThatDiesAndBoots(tid, rowId, 2)))
      .rejects.toThrow(/closed before it finished \(a restart, a stop or the watchdog\)\. It had written nothing\. Before sending it again, check read_chat_messages/);
    expect(ctx.getMessageById(rowId)!.blocks).toBeUndefined();
  });

  test("the person reads one notice: the prose row carries no verdict, the restart notice after it does", async () => {
    const rowId = turnCutMidway("boot-list", false);
    await send("boot-list", serverThatDiesAndBoots("boot-list", rowId, 1)).catch(() => {});
    const url = new URL("http://t.test/api/topics/boot-list/messages?limit=50");
    const { messages } = await (await createTopicsRouter(ctx)(new Request(url), url, url.pathname, "GET"))!.json() as { messages: Array<{ id: string; content: string; blocks?: Array<{ kind: string; text?: string }> }> };
    const at = messages.findIndex((m) => m.id === rowId);
    expect(messages[at].content).toBe(HALF);
    expect(messages[at].blocks?.some((b) => b.kind === "error") ?? false).toBe(false);
    expect(messages[at + 1].content).toBe(RESTART_INTERRUPTED_MARKER);
    expect(messages.filter((m) => m.blocks?.some((b) => b.kind === "error"))).toHaveLength(1);
  });
});

describe("read_chat_messages after the same restart", () => {
  test("the cut row says it was cut, a verdict row says how it ended, a finished answer says nothing", async () => {
    const tid = "boot-read";
    const rowId = turnCutMidway(tid, false);
    await send(tid, serverThatDiesAndBoots(tid, rowId, 1)).catch(() => {});
    // The next turn ends badly (a verdict on its row), the one after it ends well.
    const sessionKey = `topic:${tid}`;
    ctx.appendLocalMessage(sessionKey, "user", "riprova");
    const bad = ctx.createPartialMessage(sessionKey, "assistant");
    ctx.updateLastMessage(sessionKey, { content: "a meta'", blocks: [{ kind: "text", text: "a meta'" }, { kind: "error", text: "Risposta interrotta" }] as never, partial: undefined }, { rowId: bad.id } as never);
    ctx.appendLocalMessage(sessionKey, "user", "e ora?");
    const good = ctx.createPartialMessage(sessionKey, "assistant");
    ctx.updateLastMessage(sessionKey, { content: "fatto", partial: undefined, latencyMs: 900 } as never, { rowId: good.id } as never);

    const router = createTopicsRouter(ctx);
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      return (await router(new Request(u), u, u.pathname, "GET"))!;
    }) as typeof fetch;
    const out = JSON.parse(await callReadChatMessages({ baseUrl: "http://x", sessionKey: "topic:caller" }, { topic_id: tid }, fetchImpl)) as { messages: Array<{ role: string; content: string; note?: string }> };
    const noteOf = (content: string) => out.messages.find((m) => m.content === content)?.note;
    expect(noteOf(HALF)).toBe("cut by a server restart before it finished");
    expect(noteOf(RESTART_INTERRUPTED_MARKER)).toBeUndefined();
    expect(noteOf("a meta'")).toBe("ended badly: Risposta interrotta");
    expect(noteOf("fatto")).toBeUndefined();
    // The MCP process does not import the sweep: the opening it matches is tied here.
    expect(RESTART_INTERRUPTED_MARKER).toContain(RESTART_NOTICE_OPENING);
  });
});
