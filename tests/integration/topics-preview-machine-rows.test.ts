/**
 * The sidebar line under a chat's name is "the last thing said", and a row the
 * MACHINE wrote is not that. On 23/09 topic:33966f4e showed «Auto-continuation
 * stopped: ...» there, and before it «Objective still open: ...»: the goal
 * loop's own rows, in English, over the person's conversation. The boot
 * photograph (`GET /api/topics/previews`) now skips rows marked as machinery
 * and falls back to the line before them, like the live frame path does.
 *
 * @covers TOPIC-PREVIEW-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import type { Topic } from "../../shared/types";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("topics-preview-machine-rows");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

function topic(id: string): Topic {
  const now = new Date().toISOString();
  return {
    id, name: id, slug: id, parentId: null, sessionKey: `topic:${id}`,
    color: "blue", icon: "chat", createdAt: now, updatedAt: now, archived: false, links: [],
  } as unknown as Topic;
}

describe("GET /api/topics/previews skips the rows the machine wrote", () => {
  test("goal nudge, goal stop and board envelope never become the preview", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    ctx.saveSingleTopic(topic("gecko"));
    ctx.saveSingleTopic(topic("plain"));

    const insert = ctx.db.prepare(
      "INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    );
    const rows: Array<[string, "user" | "assistant", string, string | null]> = [
      ["g1", "assistant", "Ho rifatto le zanne come nella guida.", null],
      ["g2", "user", "Objective still open: Kaumat v14. Continue.", '[{"kind":"goal-nudge","attempt":1}]'],
      ["g3", "assistant", "Auto-continuation stopped: 2 turns in a row with no tool run.", '[{"kind":"goal-stop","reason":"stalled"}]'],
      ["g4", "user", "You are the exclusive owner of task 1 on this board.", '[{"kind":"dispatched-envelope"}]'],
    ];
    rows.forEach(([id, role, content, blocks], i) =>
      insert.run(id, "topic:gecko", role, content, blocks, new Date(Date.now() + i * 1000).toISOString(), i + 1));
    insert.run("p1", "topic:plain", "user", "una domanda qualsiasi", null, new Date().toISOString(), 1);

    const url = new URL("http://h/api/topics/previews");
    const res = await router(new Request(url), url, url.pathname, "GET");
    const { previews } = (await res!.json()) as { previews: Record<string, { text: string; role: string }> };

    expect(previews.gecko?.text).toBe("Ho rifatto le zanne come nella guida.");
    expect(previews.gecko?.role).toBe("assistant");
    expect(previews.plain?.text).toBe("una domanda qualsiasi");
  });
});
