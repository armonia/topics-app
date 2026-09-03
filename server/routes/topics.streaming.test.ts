/**
 * GET /api/topics/streaming walks the registry, not the topics table.
 *
 * The defect, measured: every 15s each client asked this route, and the route
 * answered by hydrating EVERY topic (`loadTopics()`: 1,452 rows plus the four
 * relation-table scans of buildTopicRelations) to keep the zero, one or two
 * whose session key sits in `activeStreams`, an in-memory Map with as many
 * entries. That churn is what kept the idle server warm.
 *
 * The harness counts the calls: with two active streams the route must call
 * `loadTopics` zero times and `getTopicBySessionKey` once per stream. The
 * behaviour it must keep is pinned too: a stale stream (isStreaming says no)
 * is skipped without being deleted, and a stream whose topic row is gone is
 * omitted, as the old filter omitted it.
 *
 * @covers STREAM-SNAPSHOT-01
 */
import { describe, test, expect, mock } from "bun:test";
import { createTopicsRouter } from "./topics";
import type { Topic } from "../types";

mock.module("./terminal", () => ({
  getTerminalSessionById: () => undefined,
}));

function makeTopic(id: string): Topic {
  return {
    id,
    name: id,
    slug: id,
    parentId: null,
    links: [],
    sessionKey: `topic:${id}`,
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
  } as Topic;
}

function makeHarness(opts: { streams: string[]; stale?: string[]; topics: Topic[] }) {
  const topics = new Map(opts.topics.map((t) => [t.id, t]));
  const activeStreams = new Map<string, { sessionKey: string }>();
  for (const k of opts.streams) activeStreams.set(k, { sessionKey: k });
  const calls = { loadTopics: 0, getTopicBySessionKey: 0 };
  const ctx = {
    OPENCLAW_DIR: "/nonexistent-openclaw-dir",
    activeStreams,
    isStreaming: (k: string) => (activeStreams.has(k) && !(opts.stale ?? []).includes(k) ? activeStreams.get(k) : undefined),
    loadTopics: () => { calls.loadTopics += 1; return { topics: Object.fromEntries(topics) }; },
    getTopicBySessionKey: (key: string) => {
      calls.getTopicBySessionKey += 1;
      return [...topics.values()].find((t) => t.sessionKey === key) ?? null;
    },
    getTopicById: (id: string) => topics.get(id) ?? null,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute: () => null,
    broadcastToAll: () => {},
    // No `prepare`: the last-row fallback of the route is wrapped in try/catch
    // and must survive a db that cannot answer it.
    db: {},
    projectStore: { list: () => [], getByPath: () => null },
  } as any;
  const router = createTopicsRouter(ctx);
  const call = async () => {
    const url = new URL("http://topics.test/api/topics/streaming");
    const res = await router(new Request(url.toString()), url, url.pathname, "GET");
    return { res: res!, body: await res!.json() as { sessions: Array<{ topicId: string; sessionKey: string; state: string }> } };
  };
  return { call, calls, activeStreams };
}

describe("GET /api/topics/streaming", () => {
  test("two live streams: zero loadTopics, one lookup per stream", async () => {
    const h = makeHarness({ streams: ["topic:a", "topic:b"], topics: [makeTopic("a"), makeTopic("b"), makeTopic("c")] });
    const { res, body } = await h.call();
    expect(res.status).toBe(200);
    expect(body.sessions.map((s) => s.topicId).sort()).toEqual(["a", "b"]);
    expect(body.sessions.every((s) => s.state === "streaming")).toBe(true);
    expect(h.calls.loadTopics, "the whole table must not be hydrated to answer for two sessions").toBe(0);
    expect(h.calls.getTopicBySessionKey).toBe(2);
  });

  test("no stream at all: no query, empty answer", async () => {
    const h = makeHarness({ streams: [], topics: [makeTopic("a")] });
    const { body } = await h.call();
    expect(body.sessions).toEqual([]);
    expect(h.calls.loadTopics).toBe(0);
    expect(h.calls.getTopicBySessionKey).toBe(0);
  });

  test("a stale stream is skipped and left in the Map for the sweeper", async () => {
    const h = makeHarness({ streams: ["topic:a", "topic:old"], stale: ["topic:old"], topics: [makeTopic("a"), makeTopic("old")] });
    const { body } = await h.call();
    expect(body.sessions.map((s) => s.topicId)).toEqual(["a"]);
    expect(h.activeStreams.has("topic:old"), "never deleted here: server.ts owns the finalisation").toBe(true);
  });

  test("a stream whose topic row is gone is omitted, as before", async () => {
    const h = makeHarness({ streams: ["topic:ghost", "topic:a"], topics: [makeTopic("a")] });
    const { body } = await h.call();
    expect(body.sessions.map((s) => s.topicId)).toEqual(["a"]);
  });
});
