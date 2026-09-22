/** @covers MP-API-01 */
import { expect, test } from "bun:test";
import { createChatRouter } from "./chat";
import { resolveTopicProvider } from "../providers/resolve-topic-provider";
import type { AppContext } from "../types";

test("an unavailable per-message provider is rejected before persistence or default routing", async () => {
  let appended = 0;
  let defaults = 0;
  const ctx = {
    json: (data: unknown, status = 200) => Response.json(data, { status }),
    readJSON: (request: Request) => request.json(),
    getTopicBySessionKey: () => null,
    isStreaming: () => undefined,
    appendLocalMessage: () => { appended++; },
  } as unknown as AppContext;
  const router = createChatRouter(ctx, {
    resolveProvider: () => { defaults++; throw new Error("must not select a default"); },
    browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
  } as unknown as Parameters<typeof createChatRouter>[1]);
  const url = new URL("http://topics.test/api/chat");
  const response = await router(new Request(url, {
    method: "POST", body: JSON.stringify({ sessionKey: "topic:provider-choice-test", provider: "missing-gpt-provider", messages: [{ role: "user", content: "test" }] }),
  }), url, url.pathname, "POST");
  expect(response?.status).toBe(503);
  expect(await response!.json()).toMatchObject({ code: "provider_unavailable", provider: "missing-gpt-provider" });
  expect(appended).toBe(0);
  expect(defaults).toBe(0);
});

test("AICTRL-01: ON + a non-routable pinned provider blocks the send with the typed reason, before persistence, provider/model untouched", async () => {
  let appended = 0;
  const codex = { name: "codex", connected: true };
  const registry = {
    getProvider: (name: string) => (name === "codex" ? codex : (() => { throw new Error("not registered"); })()),
    getDefaultProvider: () => codex,
  };
  const topic = { id: "t1", provider: "codex", model: "gpt-5-codex", topicsRouting: true };
  const ctx = {
    json: (data: unknown, status = 200) => Response.json(data, { status }),
    readJSON: (request: Request) => request.json(),
    getTopicBySessionKey: () => topic,
    isStreaming: () => undefined,
    appendLocalMessage: () => { appended++; },
  } as unknown as AppContext;
  const router = createChatRouter(ctx, {
    resolveProvider: (t: typeof topic) => resolveTopicProvider(t, registry as any),
    browserNavigatedTopics: new Set(), WORKSPACE_DIR: "/tmp",
  } as unknown as Parameters<typeof createChatRouter>[1]);
  const url = new URL("http://topics.test/api/chat");
  const response = await router(new Request(url, {
    method: "POST", body: JSON.stringify({ sessionKey: "topic:t1", messages: [{ role: "user", content: "test" }] }),
  }), url, url.pathname, "POST");
  // The typed error crosses the HTTP boundary with a stable code, not the
  // generic provider_unavailable 503 this route also returns.
  expect(response?.status).toBe(409);
  const payload = await response!.json();
  expect(payload).toMatchObject({ code: "topics_routing_incompatible", provider: "codex" });
  expect(typeof payload.error).toBe("string");
  expect(payload.error.length).toBeGreaterThan(0);
  // Blocked before the turn was recorded, and the pinned choice is untouched.
  expect(appended).toBe(0);
  expect(topic.provider).toBe("codex");
  expect(topic.model).toBe("gpt-5-codex");
  expect(topic.topicsRouting).toBe(true);
});
