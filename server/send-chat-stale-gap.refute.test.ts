/**
 * @covers CHAT-STREAM-01
 * PREMISE, on the real code: a live turn inside a silent tool drops out of
 * GET /api/topics/streaming once its lastActivity is > 3 min old, while its row
 * is still partial with half a reply, and the real messages route serves that
 * half. This is exactly what awaitTurnEndAndReadReply reads as "turn over".
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import { createTopicsRouter } from "./routes/topics";
import { sweepStaleStreams } from "./lib/stale-stream-sweep";
import type { AppContext, Topic } from "./types";

const DATA_DIR_BEFORE = process.env.DATA_DIR;
let tmpRoot: string;
let ctx: AppContext;
const SK = "topic:stalegap1";
const TID = "stalegap-aaaa-bbbb-cccc-000000000001";

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "stale-gap-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.OPENCLAW_DIR = join(tmpRoot, "openclaw");
  ctx = createAppContext(tmpRoot);
  const now = new Date().toISOString();
  ctx.saveSingleTopic({ id: TID, name: "Gap", slug: "gap", parentId: null, links: [], sessionKey: SK, color: "#aabbcc", icon: "chat", createdAt: now, updatedAt: now, archived: false } as Topic);
});
afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (DATA_DIR_BEFORE === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = DATA_DIR_BEFORE;
});

describe("stale gap on the real registry + routes", () => {
  test("live turn, silent tool 181 s: /api/topics/streaming omits it, /messages serves the half", async () => {
    ctx.appendLocalMessage(SK, "user", "ping");
    const partial = ctx.createPartialMessage(SK, "assistant");
    ctx.startStream(SK, partial.id, new AbortController(), true);
    ctx.updateLastMessage(SK, { content: "half " }, { rowId: partial.id } as never);
    ctx.addToolCallToLastMessage(SK, { id: "tc1", name: "Bash", args: { command: "sleep 600" }, status: "running", startedAt: Date.now() - 181_000 } as never, { rowId: partial.id });
    // Silent tool: nothing bumps activity for 181 s (soft timer suspended while a tool runs).
    ctx.activeStreams.get(SK)!.lastActivity = new Date(Date.now() - 181_000).toISOString();

    expect(ctx.activeStreams.has(SK)).toBe(true);        // turn still registered (alive)
    expect(ctx.isStreaming(SK)).toBeUndefined();          // ...but "not streaming"

    const router = createTopicsRouter(ctx);
    const get = async (p: string) => {
      const url = new URL(`http://t.test${p}`);
      const res = await router(new Request(url.toString()), url, url.pathname, "GET");
      return res!.json() as Promise<any>;
    };
    const streaming = await get("/api/topics/streaming");
    console.log("streaming =", JSON.stringify(streaming));
    expect(streaming.sessions.find((s: any) => s.sessionKey === SK)).toBeUndefined();

    const msgs = await get(`/api/topics/${TID}/messages?limit=50`);
    const last = msgs.messages[msgs.messages.length - 1];
    console.log("last row =", JSON.stringify({ role: last.role, content: last.content, partial: last.partial }));
    expect(last.content.trim()).toBe("half");
    expect(last.partial).toBe(true);

    // The sweeper at 181 s would NOT finalize: child alive + tool running -> it extends.
    const outcomes = sweepStaleStreams({
      now: () => Date.now(), timeoutMs: 180_000, askTtlMs: 30 * 60_000,
      activeStreams: ctx.activeStreams as never, rescued: new Set(), silence: new Map(),
      getMessageById: (id: string) => ctx.getMessageById(id) as never,
      humanHoldAgeMs: () => null, childAlive: () => true,
      resyncStream: () => {}, cancelAsk: () => {}, updateStreamActivity: (sk: string) => ctx.updateStreamActivity(sk),
      getTopicId: () => TID, abortProvider: () => {}, endStream: () => [], broadcast: () => {},
      finalizeMessage: () => {}, recordTurnEnd: () => {}, warn: () => {}, info: () => {},
    } as never);
    console.log("sweep outcome =", outcomes.get(SK));
    expect(["rescued", "extended"]).toContain(outcomes.get(SK) as string);
    expect(ctx.isStreaming(SK)).toBeDefined(); // back in the list after the tick: the gap was only a gap
  });
});
