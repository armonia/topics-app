/**
 * A CHAT WITH ITS MODEL AND EFFORT IN ONE POST.
 * @covers TOPIC-01
 *
 * Creating a chat used to take POST /api/topics, then PATCH for model and
 * effort, then /api/chat for the first prompt. The create route now takes all
 * of them, with the same effort validation as PATCH.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, cleanupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "./topics";

const ROOT = testTmpDir("topics-create-one-call");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

async function post(body: unknown) {
  const ctx = await createTestAppContext();
  const router = createTopicsRouter(ctx);
  const url = new URL("http://t.test/api/topics");
  const res = await router(new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), url, url.pathname, "POST");
  return { ctx, status: res!.status, body: (await res!.json()) as any };
}

describe("POST /api/topics with model and effort", () => {
  test("stores model and effort on the new chat", async () => {
    const { ctx, status, body } = await post({ name: "one-call", model: "claude-opus-5-5", effort: "High" });
    expect(status).toBe(201);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.effort).toBe("high");
    const saved = ctx.getTopicById(body.id);
    expect(saved?.model).toBe("claude-opus-5-5");
    expect(saved?.effort).toBe("high");
  });

  test("an unknown effort tier is a 400 and no chat is created", async () => {
    const { ctx, status } = await post({ name: "bad-effort", effort: "turbo-nonsense" });
    expect(status).toBe(400);
    expect(Object.values(ctx.loadTopics().topics).some((t) => t.name === "bad-effort")).toBe(false);
  });

  test("without model and effort the chat keeps the defaults", async () => {
    const { status, body } = await post({ name: "plain" });
    expect(status).toBe(201);
    expect(body.model ?? null).toBeNull();
    expect(body.effort ?? null).toBeNull();
  });
});
