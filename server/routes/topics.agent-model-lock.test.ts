/**
 * A BOARD AGENT CANNOT DECLARE ITS OWN MODEL (card 964ea861).
 *
 * The thread of a card shows the agent's model next to its signature, and that
 * model is `topics.model`. Through the API it was a free string: the agent's
 * shell could PATCH its topic and claim any model. For a topic that is the agent
 * of a board task, `model` now moves only from the interface (the interface
 * mark and no agent credential, the rule of `lib/created-by.ts`).
 *
 * Mutation: drop the check in the PATCH route and the API test turns green on
 * a model the agent declared about itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { createTopicsRouter } from "./topics";
import { getDatabase } from "../db";
import type { Topic } from "../types";

const ROOT = testTmpDir("topics-agent-model-lock");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => cleanupTestDataDir(ROOT));

async function rig(name: string, boardAgent: boolean) {
  const ctx = await createTestAppContext();
  (ctx as unknown as { broadcastToAll: (m: unknown) => void }).broadcastToAll = () => {};
  const now = new Date().toISOString();
  const topic = {
    id: `t-${name}`, name, slug: name, parentId: null, links: [], sessionKey: `topic:${name}`,
    color: "#5865f2", icon: "MessageSquare", createdAt: now, updatedAt: now, archived: false,
    model: "claude-opus-5",
  } as Topic;
  ctx.saveSingleTopic(topic);
  if (boardAgent) {
    getDatabase().run(
      "INSERT INTO tasks (id, project_id, text, status, assigned_topic_id, created_at, updated_at) VALUES (?, 'p1', 'card', 'in_progress', ?, datetime('now'), datetime('now'))",
      [`task-${name}`, topic.id],
    );
  }
  const router = createTopicsRouter(ctx);
  const patch = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const url = new URL(`http://topics.test/api/topics/${topic.id}`);
    const req = new Request(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return (await router(req, url, url.pathname, "PATCH")) as Response;
  };
  return { ctx, topic, patch, model: () => ctx.getTopicById(topic.id)?.model ?? null };
}

describe("the model of a board agent's topic", () => {
  test("an API call cannot declare it, and the stored model stays the card's", async () => {
    const h = await rig("agent-api", true);
    const res = await h.patch({ model: "claude-fable-5" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("agent_topic_model_locked");
    expect(h.model()).toBe("claude-opus-5");
  });

  test("the interface still changes it", async () => {
    const h = await rig("agent-ui", true);
    const res = await h.patch({ model: "claude-fable-5" }, { "X-Topics-Action-Origin": "interface" });
    expect(res.status).toBe(200);
    expect(h.model()).toBe("claude-fable-5");
  });

  test("an ordinary chat keeps taking it from the API", async () => {
    const h = await rig("plain-chat", false);
    const res = await h.patch({ model: "claude-fable-5" });
    expect(res.status).toBe(200);
    expect(h.model()).toBe("claude-fable-5");
  });

  test("other fields of a board agent's topic still move through the API", async () => {
    const h = await rig("agent-rename", true);
    const res = await h.patch({ name: "renamed" });
    expect(res.status).toBe(200);
    expect(h.model()).toBe("claude-opus-5");
  });
});
