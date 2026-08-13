/**
 * Conversation pack — branch-level message operations.
 *
 *  · DELETE /api/messages/:id — subtree delete + dense sibling renumber +
 *    active-branch repair (branches.ts).
 *  · POST /api/messages/:id/regenerate — validation surface (the streaming
 *    happy-path needs a live provider, exercised via the chat E2E env).
 *  · createBranchPartialMessage — allocates the NEXT branch index and
 *    activates it (was hardcoded 0: fine for edit, colliding for regenerate).
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";

const TEST_DATA = testTmpDir("branch-ops-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

let seq = 0;
function msg(p: Partial<StoredMessage> & Pick<StoredMessage, "id" | "role" | "content">): StoredMessage {
  return { timestamp: new Date(Date.now() + seq++ * 1000).toISOString(), ...p };
}

/** user(u1) → assistant(a1) → user(u2) → assistant(a2), linear. Ids are
 *  prefixed per session — messages.id is a GLOBAL primary key. */
function seedLinearThread(ctx: AppContext, sessionKey: string, p: string): void {
  ctx.saveLocalMessages(sessionKey, [
    msg({ id: `${p}-u1`, role: "user", content: "first question" }),
    msg({ id: `${p}-a1`, role: "assistant", content: "first answer", parentId: `${p}-u1` }),
    msg({ id: `${p}-u2`, role: "user", content: "second question", parentId: `${p}-a1` }),
    msg({ id: `${p}-a2`, role: "assistant", content: "second answer", parentId: `${p}-u2` }),
  ]);
}

async function makeRouters() {
  const { createBranchesRouter } = await import("../../server/routes/branches");
  const { createEditRouter } = await import("../../server/routes/edit");
  const ctx = await createTestAppContext();
  const branches = createBranchesRouter(ctx);
  const edit = createEditRouter(ctx, {
    resolveProvider: () => { throw new Error("no provider in this test"); },
    updateUnreadCount: () => {},
  });
  return { ctx, branches, edit };
}

function del(router: (r: Request, u: URL, p: string, m: string) => ReturnType<import("../../server/types").RouteHandler>, id: string) {
  const url = new URL(`http://h/api/messages/${id}`);
  return router(new Request(url, { method: "DELETE" }), url, `/api/messages/${id}`, "DELETE");
}

describe("DELETE /api/messages/:id", () => {
  test("deletes the subtree and returns the shortened active thread", async () => {
    const { ctx, branches } = await makeRouters();
    seedLinearThread(ctx, "topic:del-1", "d1");

    const resp = (await del(branches, "d1-u2"))!;
    expect(resp.status).toBe(200);
    const { messages } = (await resp.json()) as { messages: StoredMessage[] };
    // u2 AND its child a2 are gone; thread ends at a1.
    expect(messages.map(m => m.id)).toEqual(["d1-u1", "d1-a1"]);
    expect(ctx.getMessageById("d1-a2")).toBeNull();
  });

  test("deleting a sibling renumbers the survivors densely and repairs the active branch", async () => {
    const { ctx, branches } = await makeRouters();
    ctx.saveLocalMessages("topic:del-2", [
      msg({ id: "d2-u1", role: "user", content: "q" }),
      msg({ id: "d2-a0", role: "assistant", content: "answer v1", parentId: "d2-u1", branchIndex: 0 }),
      msg({ id: "d2-a1", role: "assistant", content: "answer v2", parentId: "d2-u1", branchIndex: 1 }),
      msg({ id: "d2-a2", role: "assistant", content: "answer v3", parentId: "d2-u1", branchIndex: 2 }),
    ]);
    ctx.switchActiveBranch("topic:del-2", "d2-u1", 1); // active = d2-a1

    const resp = (await del(branches, "d2-a1"))!;
    expect(resp.status).toBe(200);
    const { messages } = (await resp.json()) as { messages: StoredMessage[] };
    // Two siblings survive, renumbered 0/1; active clamped onto the slot the
    // deleted branch occupied → a-2 (was index 2, now 1).
    expect(messages.map(m => m.id)).toEqual(["d2-u1", "d2-a2"]);
    const tail = messages[1];
    expect(tail.siblingCount).toBe(2);
    expect(tail.activeBranchIndex).toBe(1);
    const survivors = ctx.getSiblingMessages("d2-u1");
    expect(survivors.map(s => s.branchIndex)).toEqual([0, 1]);
  });

  test("404 on unknown id", async () => {
    const { branches } = await makeRouters();
    const resp = (await del(branches, "nope"))!;
    expect(resp.status).toBe(404);
  });

  test("non lascia pin e menzioni appesi, e il marcatore di compattazione eredita il padre", async () => {
    // Nessuna di queste tabelle ha una FK verso `messages`: prima della bonifica
    // del 30/07 cancellare un messaggio lasciava righe che puntavano nel vuoto
    // (due se ne contavano nel DB vivo). Il marcatore invece non si butta —
    // dice "la compattazione sta DOPO questo messaggio", quindi eredita il padre
    // del sottoalbero e resta nello stesso punto del thread.
    const { ctx, branches } = await makeRouters();
    const sk = "topic:del-refs";
    seedLinearThread(ctx, sk, "dr");
    ctx.db.prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run("t-del-refs", "refs", "refs", sk);
    ctx.db.prepare(`INSERT INTO topic_pinned_messages (topic_id, message_id) VALUES (?, ?)`)
      .run("t-del-refs", "dr-a2");
    ctx.db.prepare(
      `INSERT INTO mentions (message_id, session_key, mentioned_entity, entity_type, created_at)
       VALUES (?, ?, ?, 'agent', datetime('now'))`,
    ).run("dr-a2", sk, "@qualcuno");
    ctx.db.prepare(
      `INSERT INTO compaction_markers (id, topic_id, session_key, after_message_id, trigger)
       VALUES (?, ?, ?, ?, 'manual')`,
    ).run("cm-del-refs", "t-del-refs", sk, "dr-a2");

    // Cancella u2: si porta dietro a2, su cui pendono pin, menzione e marcatore.
    expect((await del(branches, "dr-u2"))!.status).toBe(200);

    const n = (sql: string) => (ctx.db.query(sql).get() as { n: number }).n;
    expect(n(`SELECT COUNT(*) n FROM topic_pinned_messages WHERE message_id = 'dr-a2'`)).toBe(0);
    expect(n(`SELECT COUNT(*) n FROM mentions WHERE message_id = 'dr-a2'`)).toBe(0);
    const cm = ctx.db.query(`SELECT after_message_id a FROM compaction_markers WHERE id = 'cm-del-refs'`)
      .get() as { a: string | null };
    expect(cm.a).toBe("dr-a1");
  });
});

describe("POST /api/messages/:id/regenerate — validation", () => {
  test("rejects a user message and an unknown id", async () => {
    const { ctx, edit } = await makeRouters();
    seedLinearThread(ctx, "topic:regen-1", "r1");

    const post = (id: string) => {
      const url = new URL(`http://h/api/messages/${id}/regenerate`);
      return edit(new Request(url, { method: "POST" }), url, `/api/messages/${id}/regenerate`, "POST");
    };
    expect((await post("r1-u2"))!.status).toBe(400);
    expect((await post("missing"))!.status).toBe(404);
  });
});

describe("createBranchPartialMessage — branch allocation", () => {
  test("second partial under the same parent gets the next index and becomes active", async () => {
    const ctx = await createTestAppContext();
    ctx.saveLocalMessages("topic:alloc-1", [
      msg({ id: "al-u1", role: "user", content: "q" }),
      msg({ id: "al-a1", role: "assistant", content: "original answer", parentId: "al-u1", branchIndex: 0 }),
    ]);

    const partial = ctx.createBranchPartialMessage("topic:alloc-1", "al-u1");
    expect(partial.branchIndex).toBe(1);
    // The active thread now follows the fresh partial, with the original
    // still reachable as sibling 1/2.
    const thread = ctx.loadActiveThread("topic:alloc-1");
    expect(thread.map(m => m.id)).toEqual(["al-u1", partial.id]);
    expect(thread[1].siblingCount).toBe(2);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});
