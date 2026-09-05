/**
 * How much the BOOT payload weighs.
 *
 * `GET /api/topics` returned every topic whole, system prompt included: on this
 * machine 1,471 topics, 1,448 of them archived, 1,092,800 bytes of which
 * 255,905 were prompts and 20,964 browser state - fields no list draws. It is
 * the payload of the first paint, remade on every WS reconnect (one per chat
 * pane) and re-serialised whole into localStorage.
 *
 * With the prompts out it still weighed 872 KB for 1,554 topics, 1,535 of them
 * archived (2026-09-05): the archive was 99% of a list that draws 19 rows. So
 * the archive left the boot list too, and lives behind `?archived=1`.
 *
 * Three properties, and the third is what makes the first two honest:
 *
 *  1. WEIGHT: 1,000 archived topics with a 2 KB prompt each cost the boot list
 *     nothing - not their prompt, not their row. The bar is bytes, not a
 *     ratio, and the check is blind to how they got out.
 *  2. THE ARCHIVE IS WHOLE: `?archived=1` carries every one of them, in the
 *     same list shape (no prompt, `hasSystemPrompt` in its place), and none of
 *     the live ones.
 *  3. NOTHING WAS LOST: the settings panel of one of those ARCHIVED topics
 *     still gets its prompt, from `GET /api/topics/:id`. A cut that also cut
 *     the answer would pass tests 1 and 2 and be a regression.
 *
 * @covers TOPIC-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import type { Topic, TopicsData } from "../../shared/types";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("topics-list-weight");
beforeAll(() => setupTestDataDir(join(ROOT, "data")));
afterAll(() => cleanupTestDataDir(ROOT));

const ARCHIVED = 1000;
const LIVE = 3;
const PROMPT = "you are an expert reviewer. ".repeat(74); // ~2 KB

type Router = ReturnType<typeof import("../../server/routes/topics").createTopicsRouter>;

async function call(router: Router, path: string): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  if (!res) throw new Error(`no route handled GET ${path}`);
  return res;
}

function seedTopic(id: string, archived: boolean, extra: Partial<Topic> = {}): Topic {
  const now = new Date().toISOString();
  return {
    id,
    name: `topic ${id}`,
    slug: `topic-${id}`,
    parentId: null,
    sessionKey: `topic:${id}`,
    color: "blue",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived,
    systemPrompt: PROMPT,
    ...extra,
  } as Topic;
}

describe("weight of GET /api/topics", () => {
  test("a thousand archived topics with a 2 KB prompt do not travel with the boot list", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    for (let i = 0; i < ARCHIVED; i++) ctx.saveSingleTopic(seedTopic(`weight-${i}`, true));
    for (let i = 0; i < LIVE; i++) ctx.saveSingleTopic(seedTopic(`live-${i}`, false));

    const body = await (await call(router, "/api/topics")).text();
    const data = JSON.parse(body) as TopicsData;

    // The live rows, all of them, and not one archived row among them.
    expect(Object.keys(data.topics).length).toBe(LIVE);
    expect(data.topics["live-1"]?.archived).toBe(false);
    expect(data.topics["weight-7"]).toBeUndefined();
    expect(Object.values(data.topics).some((t) => t.archived)).toBe(false);
    // The projects ride along with the boot list, as before.
    expect(Array.isArray(data.workspaceProjects)).toBe(true);

    // 2 MB of prompts, and not one of them on the wire.
    expect(body.includes(PROMPT.slice(0, 60))).toBe(false);
    // Three rows. The old bar for this seed was 600,000 bytes; a thousand
    // archived rows would be about 250 KB, so 20 KB leaves room for three
    // rows and the project list and none for the archive.
    console.log(`[topics-list-weight] GET /api/topics with ${LIVE} live + ${ARCHIVED} archived: ${body.length} bytes`);
    expect(body.length).toBeLessThan(20_000);

    // The one thing a list asks about a prompt survives: whether there is one.
    expect(data.topics["live-1"]?.hasSystemPrompt).toBe(true);
    expect(data.topics["live-1"]?.systemPrompt).toBeUndefined();
  });

  test("the archive is whole behind ?archived=1, in the same list shape", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    for (let i = 0; i < ARCHIVED; i++) ctx.saveSingleTopic(seedTopic(`weight-${i}`, true));
    for (let i = 0; i < LIVE; i++) ctx.saveSingleTopic(seedTopic(`live-${i}`, false));

    const body = await (await call(router, "/api/topics?archived=1")).text();
    const data = JSON.parse(body) as TopicsData;

    // Every archived one, and none of the live ones.
    expect(Object.keys(data.topics).length).toBe(ARCHIVED);
    expect(data.topics["weight-7"]?.archived).toBe(true);
    expect(data.topics["live-1"]).toBeUndefined();
    // Same shape as the boot list: the prompt stays home, the flag travels.
    expect(body.includes(PROMPT.slice(0, 60))).toBe(false);
    expect(data.topics["weight-7"]?.hasSystemPrompt).toBe(true);
    expect(data.topics["weight-7"]?.systemPrompt).toBeUndefined();
    console.log(`[topics-list-weight] GET /api/topics?archived=1 with ${ARCHIVED} archived: ${body.length} bytes`);
    expect(body.length).toBeLessThan(600_000);
    // The projects belong to the boot list, not to the archive.
    expect(data.workspaceProjects).toBeUndefined();
  });

  test("the panel of an ARCHIVED topic still gets its prompt", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    ctx.saveSingleTopic(seedTopic("weight-single", true, { name: "archived one", slug: "archived-one" }));

    const res = await call(router, "/api/topics/weight-single");
    expect(res.status).toBe(200);
    const { topic } = (await res.json()) as { topic: Topic };
    expect(topic.archived).toBe(true);
    expect(topic.systemPrompt).toBe(PROMPT);

    // And the literal routes that share the prefix still answer themselves.
    expect((await call(router, "/api/topics/streaming")).status).toBe(200);
  });

  test("a topic whose parent is gone is moved to the root at boot, archived or not", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const before = await createTestAppContext();
    // The schema forbids the orphan (`parent_id … ON DELETE SET NULL` under
    // foreign_keys=ON), so this is a row written before that rule: it has to
    // be smuggled in with the check off.
    before.db.run("PRAGMA foreign_keys = OFF");
    before.saveSingleTopic(seedTopic("orphan-live", false, { parentId: "ghost-parent" }));
    before.saveSingleTopic(seedTopic("orphan-archived", true, { parentId: "ghost-parent" }));
    before.saveSingleTopic(seedTopic("child-ok", false, { parentId: "orphan-live" }));
    before.db.run("PRAGMA foreign_keys = ON");
    expect(before.getTopicById("orphan-live")?.parentId).toBe("ghost-parent");

    // The next boot: a fresh context on the same database.
    const ctx = await createTestAppContext();

    // Fixed once, at boot: no request needed, and the archived row that no
    // boot list will ever carry is fixed all the same.
    expect(ctx.getTopicById("orphan-live")?.parentId).toBeNull();
    expect(ctx.getTopicById("orphan-archived")?.parentId).toBeNull();
    // A parent that exists is not touched.
    expect(ctx.getTopicById("child-ok")?.parentId).toBe("orphan-live");
    const router = createTopicsRouter(ctx);
    const data = (await (await call(router, "/api/topics")).json()) as TopicsData;
    expect(data.topics["orphan-live"]?.parentId).toBeNull();
  });
});
