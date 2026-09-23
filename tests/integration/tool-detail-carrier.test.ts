/**
 * The detail route asked with the CARRIER id of a coalesced run.
 *
 * `coalesceToolRuns` (client) merges consecutive work-only assistant messages
 * into one item that keeps the id of the FIRST one. A row inside that item asks
 * `GET /api/messages/<carrier>/tool/<call>/detail`, but the call is stored in a
 * later message of the run: the route looked only in the carrier and answered
 * 404, and the row showed a command with no output forever (990 such calls
 * measured on the live DB, 2026-09-23).
 *
 * Properties:
 *  1. a call stored in a LATER message of the same session is found;
 *  2. a call with the same id in ANOTHER session is not (no cross-session leak);
 *  3. a call stored BEFORE the carrier is not (the run only grows forward);
 *  4. an id that exists nowhere is still a 404.
 *
 * @covers WIRE-09
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ToolCall, ContentBlock } from "../../shared/types";

const ROOT = testTmpDir("tool-detail-carrier");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

function bash(id: string, output: string): ToolCall {
  return {
    id, name: "Bash", status: "success",
    args: { command: `echo ${id}` },
    detail: { type: "shell", command: `echo ${id}`, output },
    result: output,
  };
}

/** One work-only assistant message per call, as the importer writes them. */
function workOnly(id: string, parentId: string, tc: ToolCall, t: number): StoredMessage {
  return {
    id, role: "assistant", content: "", parentId,
    timestamp: new Date(Date.now() - 10_000 + t).toISOString(),
    blocks: [{ kind: "tool", toolCall: tc } as ContentBlock],
    toolCalls: [tc],
  };
}

function seed(ctx: AppContext, sessionKey: string, p: string) {
  const u = `${p}-u`;
  const msgs: StoredMessage[] = [
    { id: u, role: "user", content: "go", timestamp: new Date(Date.now() - 20_000).toISOString(), parentId: null },
    workOnly(`${p}-a0`, u, bash(`${p}-before`, "before-out"), 0),
    { id: `${p}-reply`, role: "assistant", content: "prose splits the run", parentId: `${p}-a0`, timestamp: new Date(Date.now() - 9_500).toISOString() },
    workOnly(`${p}-a1`, `${p}-reply`, bash(`${p}-c1`, "one"), 1000),
    workOnly(`${p}-a2`, `${p}-a1`, bash(`${p}-c2`, "two"), 2000),
    workOnly(`${p}-a3`, `${p}-a2`, bash(`${p}-c3`, "THREE-OUT"), 3000),
  ];
  ctx.saveLocalMessages(sessionKey, msgs);
}

async function ask(ctx: AppContext, messageId: string, toolCallId: string) {
  const { createToolDetailRouter } = await import("../../server/routes/history");
  const router = createToolDetailRouter(ctx);
  const path = `/api/messages/${encodeURIComponent(messageId)}/tool/${encodeURIComponent(toolCallId)}/detail`;
  const url = new URL(`http://h${path}`);
  const resp = (await router(new Request(url), url, path, "GET"))!;
  return { status: resp.status, body: await resp.json() as { detail?: { output?: string } | null; args?: unknown } };
}

describe("tool detail asked with the carrier id of a coalesced run", () => {
  test("a call stored in a LATER message of the same session is found", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:carrier-a", "ca");
    const r = await ask(ctx, "ca-a1", "ca-c3");
    expect(r.status).toBe(200);
    expect(r.body.detail?.output).toBe("THREE-OUT");
  });

  test("the carrier's own call still answers from the carrier", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:carrier-b", "cb");
    const r = await ask(ctx, "cb-a1", "cb-c1");
    expect(r.status).toBe(200);
    expect(r.body.detail?.output).toBe("one");
  });

  test("another session's call with that id is not returned", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:carrier-c", "cc");
    seed(ctx, "topic:carrier-d", "cd");
    // `cd-c3` lives only in session d: asking through a carrier of session c
    // must not reach it.
    const r = await ask(ctx, "cc-a1", "cd-c3");
    expect(r.status).toBe(404);
  });

  test("a call stored BEFORE the carrier is not searched", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:carrier-e", "ce");
    const r = await ask(ctx, "ce-a1", "ce-before");
    expect(r.status).toBe(404);
  });

  test("an unknown call id is still a 404", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:carrier-f", "cf");
    const r = await ask(ctx, "cf-a1", "nope");
    expect(r.status).toBe(404);
  });
});
