/**
 * How much the BOOT payload weighs.
 *
 * `GET /api/topics` returned every topic whole, system prompt included: on this
 * machine 1,471 topics, 1,448 of them archived, 1,092,800 bytes of which
 * 255,905 were prompts and 20,964 browser state - fields no list draws. It is
 * the payload of the first paint, remade on every WS reconnect (one per chat
 * pane) and re-serialised whole into localStorage.
 *
 * Two properties, and the second is what makes the first honest:
 *
 *  1. WEIGHT: 1,000 archived topics with a 2 KB prompt each cost the list
 *     nothing. The bar is bytes, not a ratio: 2 MB of prompts must not be in
 *     there, and the check is blind to how they got out.
 *  2. NOTHING WAS LOST: the settings panel of one of those ARCHIVED topics
 *     still gets its prompt, from `GET /api/topics/:id`. A cut that also cut
 *     the answer would pass test 1 and be a regression.
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

const TOPICS = 1000;
const PROMPT = "you are an expert reviewer. ".repeat(74); // ~2 KB

type Router = ReturnType<typeof import("../../server/routes/topics").createTopicsRouter>;

async function call(router: Router, path: string): Promise<Response> {
  const url = new URL(`http://h${path}`);
  const res = await router(new Request(url), url, url.pathname, "GET");
  if (!res) throw new Error(`no route handled GET ${path}`);
  return res;
}

describe("weight of GET /api/topics", () => {
  test("a thousand archived topics with a 2 KB prompt do not travel", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    const now = new Date().toISOString();
    const seeded: Topic[] = [];
    for (let i = 0; i < TOPICS; i++) {
      seeded.push({
        id: `weight-${i}`,
        name: `topic ${i}`,
        slug: `topic-${i}`,
        parentId: null,
        sessionKey: `topic:weight-${i}`,
        color: "blue",
        icon: "chat",
        createdAt: now,
        updatedAt: now,
        archived: true,
        systemPrompt: PROMPT,
      } as Topic);
    }
    for (const t of seeded) ctx.saveSingleTopic(t);

    const body = await (await call(router, "/api/topics")).text();
    const data = JSON.parse(body) as TopicsData;
    expect(Object.keys(data.topics).length).toBeGreaterThanOrEqual(TOPICS);

    // 2 MB of prompts, and not one of them on the wire.
    expect(body.includes(PROMPT.slice(0, 60))).toBe(false);
    // Room for the rest of a row (name, ids, project, timestamps) at 1,000
    // topics, and no room at all for the prompts.
    expect(body.length).toBeLessThan(600_000);

    // The one thing a list asks about a prompt survives: whether there is one.
    expect(data.topics["weight-7"]?.hasSystemPrompt).toBe(true);
    expect(data.topics["weight-7"]?.systemPrompt).toBeUndefined();
  });

  test("the panel of an ARCHIVED topic still gets its prompt", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);
    const now = new Date().toISOString();
    ctx.saveSingleTopic({
      id: "weight-single",
      name: "archived one",
      slug: "archived-one",
      parentId: null,
      sessionKey: "topic:weight-single",
      color: "blue",
      icon: "chat",
      createdAt: now,
      updatedAt: now,
      archived: true,
      systemPrompt: PROMPT,
    } as Topic);

    const res = await call(router, "/api/topics/weight-single");
    expect(res.status).toBe(200);
    const { topic } = (await res.json()) as { topic: Topic };
    expect(topic.systemPrompt).toBe(PROMPT);

    // And the literal routes that share the prefix still answer themselves.
    expect((await call(router, "/api/topics/streaming")).status).toBe(200);
  });
});
