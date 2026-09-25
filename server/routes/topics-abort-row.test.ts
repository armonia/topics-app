/**
 * THE STOP WRITES ON THE STOPPED TURN'S ROW, NOT ON THE LAST ROW (card 1046df0b).
 *
 * `POST /api/chat/abort` finalizes the live turn with what it streamed so far.
 * It knows that turn's row from the start (`stream.messageId`), and it wrote on
 * the session's LAST row instead: the same row only while nothing was written
 * after the turn. A resend writes a user row under a turn that is still alive,
 * and the Stop pressed then put the partial answer over the person's message.
 * A sub-agent's exit report is persisted while the parent turn is open, and a
 * Stop before the first token blanked it and then discarded it as an empty
 * turn.
 *
 * Writing by id moves the empty-turn discard onto the placeholder, and that
 * discard deletes a SUBTREE: the rows born during the turn hang from it, so a
 * placeholder with rows under it is kept instead.
 *
 * The real route against the real store: the rows are read back from SQLite
 * as they are, every column, before and after the Stop.
 *
 * @covers CHAT-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "./topics";
import { registerProvider, removeProvider } from "../providers";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("topics-abort-row");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

// A REAL provider in the registry, disconnected (no key): the route calls no
// provider abort, so what is measured is the route's own write.
registerProvider({ type: "openai", apiKey: "" } as never);
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

interface Harness {
  ctx: AppContext;
  stop: () => Promise<Response>;
  /** Every column of one row, as SQLite holds it. */
  rawRow: (id: string) => Record<string, unknown> | null;
}

async function harness(sessionKey: string): Promise<Harness> {
  const ctx = await createTestAppContext();
  const topic: Topic = {
    id: `t-${sessionKey}`, name: "stop", slug: "stop", parentId: null, links: [],
    sessionKey, color: "#5865f2", icon: "MessageSquare",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    archived: false, provider: "openai",
  } as Topic;
  ctx.saveSingleTopic(topic);
  const router = createTopicsRouter(ctx);
  const stop = async () => {
    const url = new URL("http://topics.test/api/chat/abort");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey }),
    });
    return (await router(req, url, url.pathname, "POST")) as Response;
  };
  const rawRow = (id: string) =>
    (ctx.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Record<string, unknown> | null) ?? null;
  return { ctx, stop, rawRow };
}

describe("POST /api/chat/abort: the partial answer goes on the turn's own row", () => {
  test("a user row written after the live turn stays byte-identical, and the turn keeps its text", async () => {
    const sk = "topic:abort-row-resend";
    const h = await harness(sk);
    h.ctx.appendLocalMessage(sk, "user", "scrivi qualcosa");
    const turn = h.ctx.createPartialMessage(sk, "assistant");
    h.ctx.startStream(sk, turn.id, new AbortController());
    h.ctx.updateStreamContent(sk, "mezza frase", "");
    // The resend: a user row born while the turn above is still alive.
    const resend = h.ctx.appendLocalMessage(sk, "user", "te lo rimando");
    const before = h.rawRow(resend.id);

    const resp = await h.stop();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, cleared: false });

    expect(h.rawRow(resend.id)).toEqual(before);
    const stopped = h.rawRow(turn.id);
    expect(stopped?.content).toBe("mezza frase");
    expect(stopped?.partial).toBe(0);
  });

  test("a Stop before the first token leaves a row born during the turn intact, and keeps the placeholder it hangs from", async () => {
    const sk = "topic:abort-row-empty";
    const h = await harness(sk);
    h.ctx.appendLocalMessage(sk, "user", "scrivi qualcosa");
    const turn = h.ctx.createPartialMessage(sk, "assistant");
    h.ctx.startStream(sk, turn.id, new AbortController());
    // A sub-agent's exit report, persisted while the parent turn is open
    // (`lib/subagent-watch.ts`): its parent is the live placeholder.
    const report = h.ctx.appendLocalMessage(sk, "assistant", "Il sotto-agente ha finito: 3 file letti.");
    expect(report.parentId).toBe(turn.id);
    const before = h.rawRow(report.id);

    const resp = await h.stop();
    expect(resp.status).toBe(200);

    expect(h.rawRow(report.id)).toEqual(before);
    // Discarding the empty placeholder would delete its subtree, the report
    // with it: it stays, finalized and empty.
    expect(h.rawRow(turn.id)).toMatchObject({ content: "", partial: 0 });
  });

  test("a Stop before the first token with nothing after it still discards the empty placeholder", async () => {
    const sk = "topic:abort-row-alone";
    const h = await harness(sk);
    h.ctx.appendLocalMessage(sk, "user", "scrivi qualcosa");
    const turn = h.ctx.createPartialMessage(sk, "assistant");
    h.ctx.startStream(sk, turn.id, new AbortController());

    const resp = await h.stop();
    expect(resp.status).toBe(200);
    expect(h.rawRow(turn.id)).toBeNull();
  });
});
