/**
 * Phase C · Initial Message round-trip via REST.
 * Pure integration: no UI, no WS roundtrip needed.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";

const TEST_DATA = testTmpDir("phase-c-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

describe("Phase C · TOPIC-IM-01 — initial message", () => {

  test("create + read + clear round-trip", async () => {
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    // CREATE with initialMessage
    const createUrl = new URL("http://h/api/topics");
    const createReq = new Request(createUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "T", initialMessage: "hello agent, do X" }),
    });
    const createResp = await router(createReq, createUrl, "/api/topics", "POST");
    expect(createResp?.status).toBe(201);
    const created = (await createResp!.json()) as { id: string; initialMessage?: string };
    expect(created.initialMessage).toBe("hello agent, do X");

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
    const { createTopicsRouter } = await import("../../server/routes/topics");
    const ctx = await createTestAppContext();
    const router = createTopicsRouter(ctx);

    const url = new URL("http://h/api/topics");
    // \t = 0x09 keeper; \n = 0x0a keeper; \x07 BEL stripped; \x1b ESC stripped.
    const dirty = "Step 1:\n\tlist files\x07\x1b";
    const resp = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "T", initialMessage: dirty }),
      }),
      url,
      "/api/topics",
      "POST",
    );
    expect(resp?.status).toBe(201);
    const created = (await resp!.json()) as { initialMessage?: string };
    expect(created.initialMessage).toBe("Step 1:\n\tlist files");

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});
