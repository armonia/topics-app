/**
 * Edit and regenerate refuse the coordinator before any sibling or provider work.
 * @covers GLOBAL-ORCHESTRATOR-ISOLATION-01
 */
import { describe, expect, test } from "bun:test";
import { createEditRouter } from "./edit";

const sessionKey = "topic:global-coordinator";

function rawCoordinatorDb() {
  return {
    query: (sql: string) => ({
      get: (_scope: string, key: string) =>
        sql.includes("topics.session_key") && key === sessionKey
          ? {
              scope: "global",
              topic_id: "global-coordinator",
              created_at: "2026-09-04T00:00:00.000Z",
              updated_at: "2026-09-04T00:00:00.000Z",
            }
          : null,
    }),
  };
}

function routerFor(role: "user" | "assistant") {
  let branchWrites = 0;
  const ctx = {
    db: rawCoordinatorDb(),
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    readJSON: async (req: Request) => req.json(),
    matchRoute: (pathname: string, pattern: string) => {
      const wanted = pattern.replace(":id", "message-1");
      return pathname === wanted ? { id: "message-1" } : null;
    },
    getMessageById: () => ({ id: "message-1", role, parentId: role === "assistant" ? "user-1" : null, content: "old" }),
    getMessageSessionKey: () => sessionKey,
    createBranchMessage: () => { branchWrites += 1; return { id: "should-not-exist" }; },
    isStreaming: () => false,
  } as any;
  return {
    router: createEditRouter(ctx, {
      resolveProvider: () => { throw new Error("a global edit must not resolve any provider"); },
      updateUnreadCount: () => {},
    }),
    branchWrites: () => branchWrites,
  };
}

describe("global coordinator edit/regenerate gate", () => {
  test("rejects edit before creating a sibling or resolving a fallback provider", async () => {
    const h = routerFor("user");
    const path = "/api/messages/message-1/edit";
    const req = new Request(`http://topics.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "replacement" }),
    });
    const response = await h.router(req, new URL(req.url), path, "POST");
    expect(response!.status).toBe(403);
    expect(await response!.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
    expect(h.branchWrites()).toBe(0);
  });

  test("rejects regenerate before it enters the generic one-shot provider path", async () => {
    const h = routerFor("assistant");
    const path = "/api/messages/message-1/regenerate";
    const req = new Request(`http://topics.test${path}`, { method: "POST" });
    const response = await h.router(req, new URL(req.url), path, "POST");
    expect(response!.status).toBe(403);
    expect(await response!.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
    expect(h.branchWrites()).toBe(0);
  });
});
