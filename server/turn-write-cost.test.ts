/**
 * What a turn COSTS to write, in bytes, measured instead of argued.
 *
 * The defect: `blocks` and `tool_calls` are two columns each holding the whole
 * turn, and every tool event rewrote both of them whole. The n-th event paid
 * for the n-1 before it, so the cost of a turn grew with the SQUARE of its
 * length. On the live database one message reached 3.65 MB of blocks and 3.65
 * MB of tool_calls over 127 blocks: around 250 rewrites of 1.8 MB average,
 * hundreds of MB of JSON and of SQLite pages for ONE message, on the event
 * loop, while that same turn needed it for tokens, WS frames and PTY.
 *
 * The measure here is the WAL, not a counter of our own: with the automatic
 * checkpoint off, the size of `topics.db-wal` IS the number of bytes SQLite
 * wrote. A spy on the store would count what we decided to hand over; the WAL
 * counts what the machine actually paid.
 *
 * Two runs of the same 100 tool calls of 30 KB, on the same synthetic
 * database:
 *   - `unthrottled` writes on every event, which is what the code did before;
 *   - `throttled` goes through `createBlockPersistThrottle`.
 * The gate is on the second: under 4x the final size of the row. The first is
 * there so the gate is known to be able to fail, and to keep the number that
 * justifies the change visible.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import { createBlockPersistThrottle } from "./lib/block-persist-throttle";
import type { AppContext, ContentBlock, Topic, ToolCall } from "./types";

/* DATA_DIR is shared environment: it is restored, not deleted. Same reason as
 * server/utils-message-persistence.test.ts, which explains it at length. */
const DATA_DIR_BEFORE = process.env.DATA_DIR;

let tmpRoot: string;
let ctx: AppContext;

/** What `routes/chat.ts` declares: this handler writes the same tool call into the blocks. */
const MIRRORED = { mirroredInBlocks: true } as const;

/** 100 calls of 30 KB: the shape of a long agentic turn, small enough to run in a second. */
const TOOL_CALLS = 100;
const RESULT_BYTES = 30_000;

function seedTopic(sessionKey: string, id: string) {
  const now = new Date().toISOString();
  const topic: Topic = {
    id,
    name: "Write cost",
    slug: `write-cost-${id.slice(0, 4)}`,
    parentId: null,
    links: [],
    sessionKey,
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  ctx.saveSingleTopic(topic);
}

function walBytes(): number {
  try {
    return statSync(join(tmpRoot, "data", "topics.db-wal")).size;
  } catch {
    return 0;
  }
}

/**
 * One turn: 100 tool calls announced and then completed, with the timeline
 * growing exactly as `routes/chat.ts` grows it.
 *
 * `throttle: false` is the old behaviour (persist on every event); `true` goes
 * through the throttle, flushed at the end like the end of a real turn.
 */
function runTurn(sessionKey: string, opts: { throttle: boolean }): { walDelta: number; finalBytes: number; toolCalls: number } {
  const blocks: ContentBlock[] = [];
  let blocksBytes = 0;
  const writeRow = () => ctx.updateLastMessage(sessionKey, { blocks });
  const throttle = createBlockPersistThrottle({ write: writeRow });
  const persist = () => (opts.throttle ? throttle.persist(blocksBytes) : writeRow());

  ctx.createPartialMessage(sessionKey, "assistant");
  const walBefore = walBytes();

  for (let i = 0; i < TOOL_CALLS; i++) {
    const tc: ToolCall = { id: `t${i}`, name: "Bash", args: { command: `echo ${i}` }, status: "running" };
    blocks.push({ kind: "tool", toolCall: tc });
    blocksBytes += JSON.stringify(tc).length;
    ctx.addToolCallToLastMessage(sessionKey, tc, MIRRORED);
    persist();

    const result = "x".repeat(RESULT_BYTES);
    const patch = { status: "success" as const, result, endedAt: Date.now() };
    blocks[blocks.length - 1] = { kind: "tool", toolCall: { ...tc, ...patch } };
    blocksBytes += JSON.stringify(patch).length;
    ctx.updateToolCallResult(sessionKey, tc.id, result, undefined, { endedAt: patch.endedAt }, MIRRORED);
    persist();
  }
  throttle.flush();
  throttle.dispose();

  const walDelta = walBytes() - walBefore;
  const thread = ctx.loadActiveThread(sessionKey);
  const last = thread[thread.length - 1];
  return {
    walDelta,
    finalBytes: JSON.stringify(blocks).length,
    toolCalls: last?.toolCalls?.length ?? 0,
  };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "turn-write-cost-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.OPENCLAW_DIR = join(tmpRoot, "openclaw");
  ctx = createAppContext(tmpRoot);
  // Without this SQLite recycles the WAL every 1000 pages and the measure
  // would read the checkpoint cadence instead of the bytes written.
  ctx.db.run("PRAGMA wal_autocheckpoint = 0");
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (DATA_DIR_BEFORE === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_BEFORE;
});

describe("what a turn of 100 tool calls costs to write", () => {
  test("throttled: under 4x the final size, and nothing is lost", () => {
    const sessionKey = "topic:writecost-throttled";
    seedTopic(sessionKey, "writecos-aaaa-bbbb-cccc-000000000001");
    const measured = runTurn(sessionKey, { throttle: true });

    console.log(`[write-cost] throttled: ${(measured.walDelta / 1e6).toFixed(1)} MB written for a ${(measured.finalBytes / 1e6).toFixed(1)} MB row (${(measured.walDelta / measured.finalBytes).toFixed(1)}x)`);
    expect(measured.walDelta).toBeLessThan(measured.finalBytes * 4);
    // The bytes saved must not be tool calls: the row holds the whole turn.
    expect(measured.toolCalls).toBe(TOOL_CALLS);
  });

  test("writing on every event costs more than the gate allows", () => {
    const sessionKey = "topic:writecost-unthrottled";
    seedTopic(sessionKey, "writecos-aaaa-bbbb-cccc-000000000002");
    const measured = runTurn(sessionKey, { throttle: false });

    console.log(`[write-cost] on every event: ${(measured.walDelta / 1e6).toFixed(1)} MB written for a ${(measured.finalBytes / 1e6).toFixed(1)} MB row (${(measured.walDelta / measured.finalBytes).toFixed(1)}x)`);
    // The gate above is not a formality: the behaviour it replaces fails it.
    expect(measured.walDelta).toBeGreaterThan(measured.finalBytes * 4);
    expect(measured.toolCalls).toBe(TOOL_CALLS);
  });
});
