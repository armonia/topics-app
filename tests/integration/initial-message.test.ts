/**
 * Phase C · Initial Message round-trip via REST.
 * Pure integration: no UI, no WS roundtrip needed.
  * @covers TOPIC-10
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { registerProvider, removeProvider } from "../../server/providers";
import type { StreamHandler } from "../../server/providers/types";

const TEST_DATA = testTmpDir("phase-c-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

// The chat route inside the topics router resolves the provider from the
// REGISTRY, so the fake is a registered `openai` whose turn stays open: what is
// asserted is the turn starting, not a model answering.
const sends: Array<{ sessionKey: string; content: string }> = [];
const fake = registerProvider({ type: "openai", apiKey: "" } as never) as unknown as Record<string, unknown>;
Object.defineProperty(fake, "connected", { configurable: true, get: () => true });
fake.registerStreamHandler = (_sk: string, _rid: string | undefined, _h: StreamHandler) => {};
fake.unregisterStreamHandler = () => {};
fake.sendChat = (sessionKey: string, message: unknown) => {
  const content = typeof message === "string" ? message : JSON.stringify(message);
  sends.push({ sessionKey, content });
  return new Promise(() => {});
};
fake.abort = async () => {};
afterAll(() => { try { removeProvider("openai"); } catch { /* already gone */ } });

async function createTopic(body: Record<string, unknown>) {
  const { createTopicsRouter } = await import("../../server/routes/topics");
  const ctx = await createTestAppContext();
  (ctx as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  (ctx as { broadcastToTopicSubscribers: (id: string, m: unknown) => void }).broadcastToTopicSubscribers = () => {};
  const router = createTopicsRouter(ctx);
  const url = new URL("http://h/api/topics");
  const resp = await router(
    new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    url, "/api/topics", "POST",
  );
  expect(resp?.status).toBe(201);
  const topic = (await resp!.json()) as { id: string; sessionKey: string; initialMessage?: string | null };
  const userRows = () => ctx.loadLocalMessages(topic.sessionKey).filter((m) => m.role === "user").map((m) => m.content);
  return { ctx, router, topic, userRows };
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe("Phase C · TOPIC-IM-01 — initial message", () => {

  test("the server sends it through the chat route: one user row and a turn that starts", async () => {
    sends.length = 0;
    const { ctx, router, topic, userRows } = await createTopic({ name: "T", provider: "openai", initialMessage: "ciao" });

    expect(await until(() => userRows().length > 0 && sends.length > 0)).toBe(true);
    expect(userRows()).toEqual(["ciao"]);
    expect(sends.map((s) => s.sessionKey)).toEqual([topic.sessionKey]);
    expect(sends[0]!.content).toContain("ciao");
    expect(ctx.activeStreams.has(topic.sessionKey)).toBe(true);

    // Delivered means consumed: nothing left on the topic that a reload or a
    // restart could send a second time.
    const getUrl = new URL("http://h/api/topics");
    const list = (await (await router(new Request(getUrl), getUrl, "/api/topics", "GET"))!.json()) as {
      topics: Record<string, { initialMessage?: string | null }>;
    };
    expect(list.topics[topic.id].initialMessage ?? null).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(userRows()).toEqual(["ciao"]);
    expect(sends.length).toBe(1);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("a whitespace-only initial message sends nothing", async () => {
    sends.length = 0;
    const { userRows } = await createTopic({ name: "T", provider: "openai", initialMessage: "  \n\t " });
    await new Promise((r) => setTimeout(r, 150));
    expect(userRows()).toEqual([]);
    expect(sends.length).toBe(0);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("PATCH still sets and clears the stored field", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    const createUrl = new URL("http://h/api/topics");
    const createResp = await router(
      new Request(createUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "T" }) }),
      createUrl, "/api/topics", "POST",
    );
    expect(createResp?.status).toBe(201);
    const created = (await createResp!.json()) as { id: string };

    const setUrl = new URL(`http://h/api/topics/${created.id}`);
    const setResp = await router(
      new Request(setUrl, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ initialMessage: "hello agent, do X" }) }),
      setUrl, `/api/topics/${created.id}`, "PATCH",
    );
    expect(setResp?.status).toBe(200);

    // READ via GET
    const getUrl = new URL("http://h/api/topics");
    const getResp = await router(new Request(getUrl), getUrl, "/api/topics", "GET");
    const list = (await getResp!.json()) as { topics: Record<string, { initialMessage?: string }> };
    expect(list.topics[created.id].initialMessage).toBe("hello agent, do X");

    // PATCH null → cleared
    const patchUrl = new URL(`http://h/api/topics/${created.id}`);
    const patchResp = await router(
      new Request(patchUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initialMessage: null }),
      }),
      patchUrl,
      `/api/topics/${created.id}`,
      "PATCH",
    );
    expect(patchResp?.status).toBe(200);
    const patched = (await patchResp!.json()) as { initialMessage?: string | null };
    expect(patched.initialMessage ?? null).toBeNull();

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("rejects message > 8000 chars", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    const url = new URL("http://h/api/topics");
    const huge = "x".repeat(8001);
    const resp = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "T", initialMessage: huge }),
      }),
      url,
      "/api/topics",
      "POST",
    );
    expect(resp?.status).toBe(400);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("strips control characters but preserves newlines + tabs", async () => {
    sends.length = 0;
    // \t = 0x09 keeper; \n = 0x0a keeper; \x07 BEL stripped; \x1b ESC stripped.
    const { userRows } = await createTopic({ name: "T", provider: "openai", initialMessage: "Step 1:\n\tlist files\x07\x1b" });
    expect(await until(() => userRows().length > 0)).toBe(true);
    expect(userRows()).toEqual(["Step 1:\n\tlist files"]);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});
