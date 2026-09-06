/**
 * `before` on `/api/history`: the second half of a tail-first open.
 *
 * The chat pane asks for the last N rows first (`limit: N`), then for
 * everything BEFORE the oldest of those (`limit: 0, before: <id>`). This pins
 * the three properties the client relies on: the two answers tile the thread
 * exactly (no gap, no overlap), `total` keeps counting the whole thread so the
 * client can tell a partial store from a whole one, and a `before` the server
 * does not know yields the WHOLE thread rather than nothing (the client dedups
 * by id; an empty answer would leave the pane believing the head does not
 * exist). Without `before` the route answers exactly as it did.
 * @covers WIRE-11
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";

const TEST_DATA = testTmpDir("history-before-cursor-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

/** Message ids are a global primary key: one prefix per session keeps the
 *  four fixtures of this file apart inside the shared test database. */
const prefixOf = (sessionKey: string) => sessionKey.replace(/[^a-z0-9]/gi, "");

/** A linear thread of `count` rows, ids `<prefix>-m1..mN`. */
function seedThread(ctx: AppContext, sessionKey: string, count: number): void {
  const msgs: StoredMessage[] = [];
  let parentId: string | null = null;
  const prefix = prefixOf(sessionKey);
  for (let i = 1; i <= count; i++) {
    const id = `${prefix}-m${i}`;
    msgs.push({
      id,
      role: i % 2 ? "user" : "assistant",
      content: `message ${i}`,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      parentId,
    });
    parentId = id;
  }
  ctx.saveLocalMessages(sessionKey, msgs);
}

type Answer = { messages: StoredMessage[]; total: number };
type Caller = ((body: { limit?: number; before?: string }) => Promise<Answer>) & { range: (from: number, to: number) => string[] };

async function historyCaller(sessionKey: string, count: number): Promise<Caller> {
  const { createHistoryRouter } = await import("../../server/routes/history");
  const ctx = await createTestAppContext();
  seedThread(ctx, sessionKey, count);
  const router = createHistoryRouter(ctx, {
    matchHistoryRoute: (p) => (p.startsWith("/api/history/") ? decodeURIComponent(p.slice("/api/history/".length)) : null),
    providerForSessionKey: () => { throw new Error("no provider: the fixture already has the local messages"); },
  });
  const path = `/api/history/${encodeURIComponent(sessionKey)}`;
  const call = (async (body) => {
    const url = new URL(`http://h${path}`);
    const req = new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const resp = (await router(req, url, path, "POST"))!;
    expect(resp.status).toBe(200);
    return (await resp.json()) as Answer;
  }) as Caller;
  const prefix = prefixOf(sessionKey);
  call.range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-m${from + i}`);
  return call;
}

const ids = (msgs: StoredMessage[]) => msgs.map((m) => m.id);

describe("/api/history with `before`", () => {
  test("the tail and what precedes it tile the thread, and both carry the whole count", async () => {
    const call = await historyCaller("topic:before-tiling", 120);
    const tail = await call({ limit: 40 });
    expect(ids(tail.messages)).toEqual(call.range(81, 120));
    expect(tail.total).toBe(120);

    const rest = await call({ limit: 0, before: tail.messages[0].id });
    expect(ids(rest.messages)).toEqual(call.range(1, 80));
    expect(rest.total).toBe(120);
  });

  test("`before` composes with a positive limit: the N rows right before the cursor", async () => {
    const call = await historyCaller("topic:before-limit", 120);
    const page = await call({ limit: 10, before: `${prefixOf("topic:before-limit")}-m81` });
    expect(ids(page.messages)).toEqual(call.range(71, 80));
  });

  test("an unknown cursor yields the whole thread, never an empty answer", async () => {
    const call = await historyCaller("topic:before-unknown", 12);
    const all = await call({ limit: 0, before: "not-a-row" });
    expect(ids(all.messages)).toEqual(call.range(1, 12));
    expect(all.total).toBe(12);
  });

  test("without `before` the answer is what it always was", async () => {
    const call = await historyCaller("topic:before-absent", 12);
    expect(ids((await call({ limit: 0 })).messages)).toEqual(call.range(1, 12));
    expect(ids((await call({ limit: 5 })).messages)).toEqual(call.range(8, 12));
  });
});
