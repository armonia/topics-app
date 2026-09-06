/**
 * Memory routes require a real Topic, refuse the coordinator, and stay inside the memory dir.
 * @covers GLOBAL-ORCHESTRATOR-ISOLATION-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AppContext, Topic } from "../types";
import { createMemoryRouter } from "./memory";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function topic(id: string, extra: Partial<Topic> = {}): Topic {
  return {
    id,
    name: id,
    slug: id,
    parentId: null,
    links: [],
    sessionKey: `topic:${id}`,
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    archived: false,
    ...extra,
  };
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const actual = pathname.split("/");
  const expected = pattern.split("/");
  if (actual.length !== expected.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i]!.startsWith(":")) params[expected[i]!.slice(1)] = decodeURIComponent(actual[i]!);
    else if (expected[i] !== actual[i]) return null;
  }
  return params;
}

function makeHarness(options: { topics?: Topic[]; rawGlobalTopicIds?: Iterable<string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "topics-memory-route-"));
  roots.add(root);
  const topics = new Map((options.topics ?? []).map((value) => [value.id, value]));
  const rawGlobalTopicIds = new Set(options.rawGlobalTopicIds ?? []);
  const lookups: string[] = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  const ctx = {
    STATE_DIR: root,
    db: {
      // This is deliberately the raw registry lookup.  A coordinator whose
      // backing Topic is corrupt still must not fall through to normal memory.
      query: () => ({
        get: (_scope: string, topicId: string) => rawGlobalTopicIds.has(topicId)
          ? {
              scope: "global",
              topic_id: topicId,
              created_at: "2026-09-04T00:00:00.000Z",
              updated_at: "2026-09-04T00:00:00.000Z",
            }
          : null,
      }),
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute,
    broadcastToAll: (message: Record<string, unknown>) => { broadcasts.push(message); },
    getTopicById: (id: string) => {
      lookups.push(id);
      return topics.get(id) ?? null;
    },
  } as unknown as AppContext;
  const router = createMemoryRouter(ctx);

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const url = new URL(`http://topics.test${path}`);
    const req = new Request(url.toString(), {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const response = await router(req, url, url.pathname, method);
    if (!response) throw new Error(`memory route did not handle ${method} ${path}`);
    return response;
  }

  return { root, memoryDir: join(root, "memory"), topics, lookups, broadcasts, call };
}

describe("memory route topic isolation", () => {
  test("uses a canonical existing Topic for read, write, append, and delete", async () => {
    const normal = topic("ordinary-topic");
    const h = makeHarness({ topics: [normal] });

    const put = await h.call("PUT", "/api/memory/ordinary-topic", { content: "saved note" });
    expect(put.status).toBe(200);
    expect(readFileSync(join(h.memoryDir, "ordinary-topic.md"), "utf8")).toBe("saved note");

    const get = await h.call("GET", "/api/memory/ordinary-topic");
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      topicId: normal.id,
      topicContent: "saved note",
      globalContent: "",
    });

    const append = await h.call("POST", "/api/memory/ordinary-topic/append", { content: "later note" });
    expect(append.status).toBe(200);
    expect(readFileSync(join(h.memoryDir, "ordinary-topic.md"), "utf8")).toContain("later note");

    const remove = await h.call("DELETE", "/api/memory/topic/ordinary-topic");
    expect(remove.status).toBe(200);
    expect(existsSync(join(h.memoryDir, "ordinary-topic.md"))).toBe(false);
    expect(h.broadcasts).toEqual([
      { type: "memory:updated", scope: "topic", topicId: normal.id },
      { type: "memory:updated", scope: "topic", topicId: normal.id },
      { type: "memory:updated", scope: "topic", topicId: normal.id },
    ]);
  });

  test("keeps the standalone global-memory routes working", async () => {
    const h = makeHarness();

    expect((await h.call("PUT", "/api/memory", { content: "global note" })).status).toBe(200);
    const get = await h.call("GET", "/api/memory");
    expect(await get.json()).toMatchObject({ type: "global", content: "global note" });
    expect((await h.call("DELETE", "/api/memory/global")).status).toBe(200);
    expect((await (await h.call("GET", "/api/memory")).json()).content).toBe("");
    expect(h.lookups).toEqual([]);
  });

  test("does not create, read, append, or delete memory for a nonexistent Topic", async () => {
    const h = makeHarness();
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", "/api/memory/missing-topic"],
      ["PUT", "/api/memory/missing-topic", { content: "must not write" }],
      ["POST", "/api/memory/missing-topic/append", { content: "must not append" }],
      ["DELETE", "/api/memory/topic/missing-topic"],
    ];

    for (const [method, path, body] of attempts) {
      const response = await h.call(method, path, body);
      expect(response.status).toBe(404);
    }
    expect(existsSync(join(h.memoryDir, "missing-topic.md"))).toBe(false);
    expect(h.broadcasts).toEqual([]);
  });

  test("blocks every topic-memory operation for a raw registered coordinator", async () => {
    const coordinator = topic("registered-coordinator", {
      // It is deliberately malformed.  The raw registry role, not these
      // mutable fields, must be the denial boundary.
      provider: "openclaw",
      projectPath: "/must-not-be-read",
    });
    const h = makeHarness({ topics: [coordinator], rawGlobalTopicIds: [coordinator.id] });
    const coordinatorFile = join(h.memoryDir, `${coordinator.id}.md`);
    writeFileSync(coordinatorFile, "must remain private", "utf8");
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", `/api/memory/${coordinator.id}`],
      ["PUT", `/api/memory/${coordinator.id}`, { content: "must not overwrite" }],
      ["POST", `/api/memory/${coordinator.id}/append`, { content: "must not append" }],
      ["DELETE", `/api/memory/topic/${coordinator.id}`],
    ];

    for (const [method, path, body] of attempts) {
      const response = await h.call(method, path, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "orchestrator_topic_invariant" });
    }
    expect(readFileSync(coordinatorFile, "utf8")).toBe("must remain private");
    expect(h.broadcasts).toEqual([]);
  });

  test("rejects real Topics whose ids would traverse or collide with global memory", async () => {
    const traversal = topic("../escape");
    const globalAlias = topic("_global");
    const h = makeHarness({ topics: [traversal, globalAlias] });
    const globalFile = join(h.memoryDir, "_global.md");
    writeFileSync(globalFile, "global remains global", "utf8");
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", "/api/memory/..%2Fescape"],
      ["PUT", "/api/memory/..%2Fescape", { content: "must not write outside" }],
      ["POST", "/api/memory/..%2Fescape/append", { content: "must not append outside" }],
      ["DELETE", "/api/memory/topic/..%2Fescape"],
      ["PUT", "/api/memory/_global", { content: "must not replace global" }],
    ];

    for (const [method, path, body] of attempts) {
      const response = await h.call(method, path, body);
      expect(response.status).toBe(400);
    }
    expect(existsSync(join(h.root, "escape.md"))).toBe(false);
    expect(readFileSync(globalFile, "utf8")).toBe("global remains global");
    expect(h.broadcasts).toEqual([]);
  });
});
