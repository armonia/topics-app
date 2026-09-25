/**
 * ONE ROW BY ID, AS IT IS NOW, EVEN WHEN IT IS STILL EMPTY.
 * @covers CHAT-STREAM-01
 *
 * `send_chat_message` waits on the row of a turn whose stream was cut. The
 * list route hides a partial row with no text yet, and that is the usual row
 * of a turn silent in a tool (content is saved every 10 deltas): read from the
 * list, a live turn looked gone. This route shows the row as it is, and says
 * 404 only when there is no such row in that chat.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "./topics";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("topics-message-by-id");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

function saveTopic(ctx: AppContext, id: string): string {
  const sessionKey = `topic:${id}`;
  ctx.saveSingleTopic({
    id, name: id, slug: id, parentId: null, links: [], sessionKey,
    color: "#5865f2", icon: "MessageSquare", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), archived: false,
  } as unknown as Topic);
  return sessionKey;
}

describe("GET /api/topics/:id/messages/:messageId", () => {
  test("serves the partial row with no text that the list hides, then the same row once final", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "row-live");
    const router = createTopicsRouter(ctx);
    const get = async (path: string) => {
      const url = new URL(`http://t.test${path}`);
      const res = await router(new Request(url), url, url.pathname, "GET");
      return { status: res!.status, body: await res!.json() as any };
    };

    ctx.appendLocalMessage(sessionKey, "user", "ping");
    const row = ctx.createPartialMessage(sessionKey, "assistant");

    const listed = await get("/api/topics/row-live/messages?limit=50");
    expect(listed.body.messages.some((m: { id: string }) => m.id === row.id)).toBe(false);

    const live = await get(`/api/topics/row-live/messages/${row.id}`);
    expect(live.status).toBe(200);
    expect(live.body.message).toMatchObject({ id: row.id, role: "assistant", partial: true });

    ctx.updateLastMessage(sessionKey, { content: "the whole answer", partial: undefined }, { rowId: row.id } as never);
    const done = await get(`/api/topics/row-live/messages/${row.id}`);
    expect(done.body.message.content).toBe("the whole answer");
    expect(done.body.message.partial).toBeUndefined();
  });

  test("404 for a row of another chat, an unknown row, or an unknown chat", async () => {
    const ctx = await createTestAppContext();
    const sessionKey = saveTopic(ctx, "row-mine");
    saveTopic(ctx, "row-theirs");
    const router = createTopicsRouter(ctx);
    const status = async (path: string) => {
      const url = new URL(`http://t.test${path}`);
      return (await router(new Request(url), url, url.pathname, "GET"))!.status;
    };
    const row = ctx.createPartialMessage(sessionKey, "assistant");

    expect(await status(`/api/topics/row-mine/messages/${row.id}`)).toBe(200);
    expect(await status(`/api/topics/row-theirs/messages/${row.id}`)).toBe(404);
    expect(await status("/api/topics/row-mine/messages/no-such-row")).toBe(404);
    expect(await status(`/api/topics/no-such-chat/messages/${row.id}`)).toBe(404);
  });
});
