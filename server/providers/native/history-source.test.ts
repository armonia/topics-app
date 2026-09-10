/**
 * `nativeHistorySource` is what `server.ts` hands to `configureNativeHistorySource`.
 * It used to call `ctx.loadActiveThread(sessionKey, { withBlocks: false })`, and
 * for almost every native session that throws the tool calls away before
 * `historyFromPersistedThread` ever sees them: `tool_calls` is left empty on
 * disk for a row that also carries `blocks` (`toolCallsColumnForRow`), and
 * `rowToMessage` only recovers them from `blocks` when `withBlocks` is true.
 *
 * This is a regression test for that exact wiring, not for `rowToMessage`
 * (already covered by `tool-calls-column.test.ts`): it goes through the real
 * function `server.ts` calls.
 *
 * @covers RT-04
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "../../db";
import { createAppContext } from "../../utils";
import { nativeHistorySource } from "./history-source";
import type { AppContext, ContentBlock, Topic, ToolCall } from "../../types";

const DATA_DIR_BEFORE = process.env.DATA_DIR;

let tmpRoot: string;
let ctx: AppContext;

const SK = "topic:nativehist01";

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "native-history-source-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.OPENCLAW_DIR = join(tmpRoot, "openclaw");
  ctx = createAppContext(tmpRoot);

  const now = new Date().toISOString();
  const topic: Topic = {
    id: "nathist1-aaaa-bbbb-cccc-000000000001",
    name: "Native history source",
    slug: "native-history-source",
    parentId: null,
    links: [],
    sessionKey: SK,
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  ctx.saveSingleTopic(topic);
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (DATA_DIR_BEFORE === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_BEFORE;
});

describe("nativeHistorySource — what server.ts hands to the resumed session", () => {
  test("a turn saved with blocks (the normal case) still comes back with its tool calls", () => {
    const tc: ToolCall = { id: "t1", name: "Read", args: { path: "a.ts" }, status: "success", result: "const x = 1", contentOffset: 12 };
    const blocks: ContentBlock[] = [{ kind: "tool", toolCall: tc }];
    ctx.saveLocalMessages(SK, [
      { id: "msg-user", role: "user", content: "leggi a.ts", timestamp: new Date().toISOString() },
      { id: "msg-tool", role: "assistant", content: "Leggo il file.Fatto.", timestamp: new Date().toISOString(), toolCalls: [tc], blocks },
      { id: "msg-followup", role: "user", content: "e ora?", timestamp: new Date().toISOString() },
    ]);

    const turns = nativeHistorySource(ctx, SK);
    const assistantTurn = turns.find((t) => t.role === "assistant" && t.toolCalls?.length);
    expect(assistantTurn?.toolCalls?.length).toBe(1);
    expect(assistantTurn?.toolCalls?.[0]?.id).toBe("t1");
    expect(assistantTurn?.toolCalls?.[0]?.result).toBe("const x = 1");
  });
});
