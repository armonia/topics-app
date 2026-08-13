/**
 * ⌘K message search hits the SQLite `messages` store.
 *
 * Regression for the audit finding (2026-07-10): `searchTranscripts` only
 * scanned the legacy gateway JSONL transcripts, so messages written by the
 * current chat pipeline (SQLite `messages` table) were unfindable — the
 * palette's "Messaggi" section stayed empty for any fresh conversation.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { StoredMessage } from "../../server/types";

const TEST_DATA = testTmpDir("search-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

function msg(partial: Partial<StoredMessage> & Pick<StoredMessage, "id" | "role" | "content">): StoredMessage {
  return { timestamp: new Date().toISOString(), ...partial };
}

describe("searchTranscripts — SQLite messages", () => {
  test("finds fresh chat messages and resolves their topic", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    const createUrl = new URL("http://h/api/topics");
    const createResp = (await router(
      new Request(createUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Search T" }),
      }),
      createUrl,
      "/api/topics",
      "POST",
    ))!;
    expect(createResp.status).toBe(201);
    const topic = (await createResp.json()) as { id: string; sessionKey: string };

    ctx.saveLocalMessages(topic.sessionKey, [
      msg({ id: "m1", role: "user", content: "please deploy the xylophone service" }),
      msg({ id: "m2", role: "assistant", content: "Deployed. The xylophone service is live." }),
      msg({ id: "m3", role: "user", content: "unrelated noise" }),
    ]);

    const results = ctx.searchTranscripts("XYLOPHONE");
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.topicId).toBe(topic.id);
      expect(r.topicName).toBe("Search T");
      expect(r.content.toLowerCase()).toContain("xylophone");
    }
    // Case-insensitive + both roles surfaced.
    expect(new Set(results.map((r: { role: string }) => r.role))).toEqual(new Set(["user", "assistant"]));
    // SQLite hits carry the message id — the palette uses it to scroll the
    // opened topic to the exact message (legacy JSONL hits get null instead).
    expect(new Set(results.map((r: { messageId: string }) => r.messageId))).toEqual(new Set(["m1", "m2"]));
  });

  test("user-typed LIKE wildcards match literally", async () => {
    const ctx = await createTestAppContext();
    // Reuse the store seeded above ("100% done" absent, "%" must not match-all).
    const all = ctx.searchTranscripts("%");
    expect(all.length).toBe(0);
    const underscore = ctx.searchTranscripts("_ylophone");
    expect(underscore.length).toBe(0);
  });

  test("messages of a session with no topic are skipped", async () => {
    const ctx = await createTestAppContext();
    ctx.saveLocalMessages("topic:ghost-session", [
      msg({ id: "g1", role: "user", content: "xylophone from a ghost" }),
    ]);
    const results = ctx.searchTranscripts("ghost");
    expect(results.length).toBe(0);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});
