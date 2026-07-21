/**
 * Message-row persistence isolation — regression tests for the "chat streams
 * then deletes the message" bug.
 *
 * Root cause: the shared `updateMessage` statement overwrote `content` /
 * `thinking` / `tool_calls` directly (no COALESCE), and every writer re-persisted
 * ALL of them from its own snapshot. A tool-result write (e.g. the burst a killed
 * process flushes) or a control-only update (flipping `partial` on timeout) could
 * therefore blank the streamed body. These tests pin the field-ownership contract:
 *   - a tool write NEVER touches content/thinking,
 *   - a content write NEVER touches tool_calls,
 *   - finalize / partial-only updates NEVER blank the body.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import type { AppContext, Topic, ToolCall } from "./types";

let tmpRoot: string;
let ctx: AppContext;

const SK = "topic:persist01";

function seedTopic() {
  const now = new Date().toISOString();
  const topic: Topic = {
    id: "persist01-aaaa-bbbb-cccc-000000000001",
    name: "Persistence",
    slug: "persistence",
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
}

function tool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: "Bash", args: { command: "echo hi" }, status: "running", ...over };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "msg-persist-test-"));
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
  seedTopic();
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("message field-ownership on updateMessage", () => {
  test("a tool-result write never blanks the streamed content", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.appendToLastMessage(SK, "Ecco il risultato: ");
    ctx.addToolCallToLastMessage(SK, tool("t1"));

    // The burst a killed/draining process flushes: a late tool_result.
    ctx.updateToolCallResult(SK, "t1", "hi\n", undefined, { endedAt: Date.now() });

    const row = ctx.getMessageById(msg.id)!;
    expect(row.content).toBe("Ecco il risultato: "); // NOT blanked
    expect(row.toolCalls?.[0]?.status).toBe("success");
    expect(row.toolCalls?.[0]?.result).toBe("hi\n");
  });

  test("a content delta never blanks tool state", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.addToolCallToLastMessage(SK, tool("t2", { status: "running" }));
    ctx.appendToLastMessage(SK, "testo dopo il tool");

    const row = ctx.getMessageById(msg.id)!;
    expect(row.content).toBe("testo dopo il tool");
    expect(row.toolCalls?.length).toBe(1);
    expect(row.toolCalls?.[0]?.id).toBe("t2");
  });

  test("finalizeLastMessage preserves content and tools (never a blank bubble)", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.appendToLastMessage(SK, "risposta completa");
    ctx.addToolCallToLastMessage(SK, tool("t3"));
    ctx.updateToolCallResult(SK, "t3", "done");

    ctx.finalizeLastMessage(SK);

    const row = ctx.getMessageById(msg.id)!;
    expect(row.partial).toBeFalsy();
    expect(row.content).toBe("risposta completa");
    expect(row.toolCalls?.[0]?.result).toBe("done");
  });

  test("a control-only updateLastMessage (partial flip) does not blank body", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.appendToLastMessage(SK, "quasi finito");
    ctx.addToolCallToLastMessage(SK, tool("t4"));

    // The timeout handlers do exactly this: flip the control flags without
    // re-sending content/tools.
    ctx.updateLastMessage(SK, { partial: undefined, streamedAt: undefined });

    const row = ctx.getMessageById(msg.id)!;
    expect(row.content).toBe("quasi finito");
    expect(row.toolCalls?.[0]?.id).toBe("t4");
  });

  test("endStream marks a hung 'running' tool as interrupted, stamps endedAt, returns it", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.startStream(SK, msg.id);
    ctx.addToolCallToLastMessage(SK, tool("t6", { status: "running" }));

    // Turn dies without a result → endStream must not leave the tool spinning.
    const interrupted = ctx.endStream(SK);

    expect(interrupted.map(t => t.id)).toEqual(["t6"]);
    expect(interrupted[0]?.status).toBe("error");
    expect(typeof interrupted[0]?.endedAt).toBe("number"); // duration freezes

    const row = ctx.getMessageById(msg.id)!;
    expect(row.toolCalls?.[0]?.status).toBe("error");
    expect(typeof row.toolCalls?.[0]?.endedAt).toBe("number");
  });

  test("endStream leaves already-settled tools untouched", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.startStream(SK, msg.id);
    ctx.addToolCallToLastMessage(SK, tool("t7", { status: "running" }));
    ctx.updateToolCallResult(SK, "t7", "ok");

    const interrupted = ctx.endStream(SK);

    expect(interrupted.length).toBe(0); // nothing was still running
    const row = ctx.getMessageById(msg.id)!;
    expect(row.toolCalls?.[0]?.status).toBe("success");
    expect(row.toolCalls?.[0]?.result).toBe("ok");
  });

  test("a timeout marker sets content but preserves the tool timeline", () => {
    const msg = ctx.createPartialMessage(SK, "assistant");
    ctx.addToolCallToLastMessage(SK, tool("t5"));
    ctx.updateToolCallResult(SK, "t5", "ok");

    // handleHardTimeout / handleGraceExpiry: an interrupted turn with no prose
    // gets an explicit marker — never an empty row — and keeps its tools.
    ctx.updateLastMessage(SK, { content: "⚠️ Hard timeout reached", partial: undefined, streamedAt: undefined });

    const row = ctx.getMessageById(msg.id)!;
    expect(row.content).toBe("⚠️ Hard timeout reached");
    expect(row.toolCalls?.[0]?.result).toBe("ok");
  });
});

describe("reuseOrCreatePartialForReattach — reload-survival (no duplicate turn, no ghost)", () => {
  test("reuses the surviving partial row IN PLACE, clears its body, rebuilds cleanly", () => {
    const sk = "topic:reatt01";
    const original = ctx.createPartialMessage(sk, "assistant");
    ctx.appendToLastMessage(sk, "contenuto pre-restart");
    ctx.addToolCallToLastMessage(sk, tool("rt1"));

    // Boot reattach path: continue the SAME bubble.
    const reused = ctx.reuseOrCreatePartialForReattach(sk);
    expect(reused.id).toBe(original.id); // same bubble — no duplicate, no ghost

    const cleared = ctx.getMessageById(original.id)!;
    expect(cleared.partial).toBeTruthy(); // still streaming
    expect(cleared.content).toBe(""); // body cleared for a clean JSONL replay
    expect(cleared.toolCalls == null || cleared.toolCalls.length === 0).toBe(true);

    // The replay rebuilds the same row in place.
    ctx.appendToLastMessage(sk, "turno ricostruito dal replay");
    expect(ctx.getMessageById(original.id)!.content).toBe("turno ricostruito dal replay");
  });

  test("creates a FRESH row when nothing survived (last message already finalized)", () => {
    const sk = "topic:reatt02";
    const done = ctx.createPartialMessage(sk, "assistant");
    ctx.appendToLastMessage(sk, "completo");
    ctx.finalizeLastMessage(sk);

    const fresh = ctx.reuseOrCreatePartialForReattach(sk);
    expect(fresh.id).not.toBe(done.id); // new bubble
    expect(ctx.getMessageById(fresh.id)!.partial).toBeTruthy();
    expect(ctx.getMessageById(done.id)!.content).toBe("completo"); // the finalized turn is untouched
  });

  test("creates a FRESH row on an empty session (no last message)", () => {
    const sk = "topic:reatt03-empty";
    const fresh = ctx.reuseOrCreatePartialForReattach(sk);
    expect(ctx.getMessageById(fresh.id)!.partial).toBeTruthy();
    expect(ctx.getMessageById(fresh.id)!.content).toBe("");
  });
});
