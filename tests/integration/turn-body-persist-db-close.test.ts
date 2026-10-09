/**
 * A WRITE THE THROTTLE IS HOLDING NEVER OUTLIVES THE DATABASE IT WRITES TO.
 *
 * `lib/block-persist-throttle.ts` defers a body write by 1 to 15 seconds, on
 * an unref'd timer. Nothing tied that timer to the database: closed in the
 * meantime, the write still went out later, through statements prepared on
 * the handle that was gone. In a `bun test` run of many files the next file's
 * `setupTestDataDir` closes the database, so a turn of
 * `chat-finalized-turn-late-events.test.ts` (a tool event after its close,
 * held by the throttle) wrote while `chat-tool-response-live-turn.test.ts`
 * was running: on Bun 1.3.8 `SQLiteError: out of memory` from
 * `updateLastMessage`, charged to whichever test was on; on Bun 1.4.2 no
 * error, the write landed in the closed file. In production the server's
 * shutdown closes the database and exits in the same tick, so the timer never
 * fired there: the held write was simply lost.
 *
 * Closing the database now writes what the throttle holds first, on the
 * handle that is still open.
 *
 * @covers CHAT-PERSIST-01
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import { closeDatabase } from "../../server/db";
import { createTurnBodyPersist } from "../../server/lib/turn-body-persist";
import type { ContentBlock, Topic } from "../../server/types";

const ROOT = testTmpDir("turn-body-db-close");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

test("closing the database writes the body the throttle is holding, before the handle goes", async () => {
  const ctx = await createTestAppContext();
  const sessionKey = "topic:db-close";
  const now = new Date().toISOString();
  ctx.saveSingleTopic({
    id: "t-db-close", name: "close", slug: "close", parentId: null, links: [], sessionKey,
    color: "#5865f2", icon: "MessageSquare", createdAt: now, updatedAt: now, archived: false,
  } as Topic);
  const row = ctx.createPartialMessage(sessionKey, "assistant");

  let content = "";
  const blocks: ContentBlock[] = [];
  const body = createTurnBodyPersist({
    sessionKey,
    updateLastMessage: ctx.updateLastMessage,
    rowId: () => row.id,
    blocks,
    content: () => content,
    thinking: () => "",
    trackedTools: () => 0,
    reattachSnapshot: () => null,
  });
  try {
    content = "first";
    body.request(true, 1_000); // the first write of a turn always goes through
    content = "first and second";
    body.request(true, 1_100); // not doubled: held by the throttle's timer
    expect(ctx.getMessageById(row.id)?.content).toBe("first");

    closeDatabase();

    const reopened = await createTestAppContext();
    expect(reopened.getMessageById(row.id)?.content).toBe("first and second");
  } finally {
    body.dispose();
  }
});
