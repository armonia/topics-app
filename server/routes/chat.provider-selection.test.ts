/** @covers MP-API-01 */
import { expect, test } from "bun:test";
import { createChatRouter } from "./chat";
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
