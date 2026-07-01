/**
 * Route coverage for the session-keyed control endpoints
 * (POST /api/sessions/:sessionKey/{switch-topic,new-topic,create-project,open-project})
 * — the tool-shaped successors to the {{TOPIC_SWITCH/TOPIC_NEW/PROJECT_CREATE/
 * PROJECT_OPEN}} markers (spec: replace-markers-with-tools, AC-01).
 *
 * We mount the real topicsRouter with a minimal stub AppContext (in-memory
 * topics map + broadcast capture + a temp OPENCLAW_DIR workspace), so the
 * suite asserts status codes, DB-equivalent effects (the topics map, scaffolded
 * dirs) AND the WebSocket broadcasts each endpoint must emit — without a live
 * server or SQLite. The regressions it guards:
 *   - create-project silently BOUND an existing directory on name collision
 *     instead of returning 409 (AC-01 "SHALL return HTTP 409 if a project with
 *     that name already exists");
 *   - switch-topic returned 404 for an ARCHIVED target, conflating it with
 *     "does not exist" (AC-01 says 404 unknown / 400 archived).
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTopicsRouter } from "./topics";
import type { Topic } from "../types";

function makeTopic(overrides: Partial<Topic> & { id: string }): Topic {
  return {
    name: overrides.id,
    slug: overrides.id,
    parentId: null,
    links: [],
    sessionKey: `topic:${overrides.id}`,
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    ...overrides,
  } as Topic;
}

/** Minimal stub AppContext: just what the control-endpoint paths dereference. */
function makeHarness() {
  const openclawDir = mkdtempSync(join(tmpdir(), "topics-ctrl-"));
  const workspaceDir = join(openclawDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  const topics = new Map<string, Topic>();
  const broadcasts: Array<{ type: string } & Record<string, unknown>> = [];

  const ctx = {
    OPENCLAW_DIR: openclawDir,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const patternParts = pattern.split("/");
      const pathParts = pathname.split("/");
      if (patternParts.length !== pathParts.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(":")) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        else if (patternParts[i] !== pathParts[i]) return null;
      }
      return params;
    },
    slugify: (name: string) =>
      name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    broadcastToAll: (msg: { type: string } & Record<string, unknown>) => { broadcasts.push(msg); },
    getTopicById: (id: string) => topics.get(id) ?? null,
    getTopicBySessionKey: (key: string) =>
      [...topics.values()].find((t) => t.sessionKey === key) ?? null,
    loadTopics: () => ({ topics: Object.fromEntries(topics) }),
    saveSingleTopic: (t: Topic) => { topics.set(t.id, t); },
    projectStore: {
      list: () => [],
      getByPath: () => null,
      slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    },
  } as any;

  const router = createTopicsRouter(ctx);
  const call = (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://topics.test${path}`);
    const req = new Request(url.toString(), {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return router(req, url, url.pathname, method) as Promise<Response | null>;
  };
  const cleanup = () => rmSync(openclawDir, { recursive: true, force: true });

  return { topics, broadcasts, workspaceDir, call, cleanup };
}

describe("POST /api/sessions/:sessionKey/switch-topic", () => {
  test("200 + topic:switch broadcast for an existing non-archived target", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      h.topics.set("tgt", makeTopic({ id: "tgt" }));
      const resp = (await h.call("POST", "/api/sessions/topic:cur/switch-topic", { topicId: "tgt" }))!;
      expect(resp.status).toBe(200);
      expect((await resp.json()).toTopicId).toBe("tgt");
      const sw = h.broadcasts.find((b) => b.type === "topic:switch");
      expect(sw).toMatchObject({ fromTopicId: "cur", fromSessionKey: "topic:cur", toTopicId: "tgt", toSessionKey: "topic:tgt" });
    } finally { h.cleanup(); }
  });

  test("400 (not 404) when the target topic is archived", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      h.topics.set("dead", makeTopic({ id: "dead", archived: true }));
      const resp = (await h.call("POST", "/api/sessions/topic:cur/switch-topic", { topicId: "dead" }))!;
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.error).toMatch(/archived/i);
      expect(body.code).toBe("topic_archived");
      expect(h.broadcasts.filter((b) => b.type === "topic:switch")).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("404 when the target topic does not exist", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      const resp = (await h.call("POST", "/api/sessions/topic:cur/switch-topic", { topicId: "ghost" }))!;
      expect(resp.status).toBe(404);
      expect(h.broadcasts.filter((b) => b.type === "topic:switch")).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("404 when the sessionKey maps to no topic", async () => {
    const h = makeHarness();
    try {
      const resp = (await h.call("POST", "/api/sessions/topic:nobody/switch-topic", { topicId: "x" }))!;
      expect(resp.status).toBe(404);
      expect((await resp.json()).error).toMatch(/no chat topic/i);
    } finally { h.cleanup(); }
  });

  test("400 when topicId missing", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      const resp = (await h.call("POST", "/api/sessions/topic:cur/switch-topic", {}))!;
      expect(resp.status).toBe(400);
    } finally { h.cleanup(); }
  });
});

describe("POST /api/sessions/:sessionKey/new-topic", () => {
  test("creates the topic (inheriting projectPath) and broadcasts topic:created then topic:switch", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur", projectPath: "/tmp/proj" }));
      const resp = (await h.call("POST", "/api/sessions/topic:cur/new-topic", { title: "My Findings" }))!;
      expect(resp.status).toBe(200);
      const { topicId } = await resp.json();
      expect(topicId).toBeTruthy();

      const created = h.topics.get(topicId)!;
      expect(created.name).toBe("My Findings");
      expect(created.projectPath).toBe("/tmp/proj"); // inherited
      expect(created.archived).toBe(false);

      const types = h.broadcasts.map((b) => b.type);
      expect(types.indexOf("topic:created")).toBeGreaterThanOrEqual(0);
      expect(types.indexOf("topic:created")).toBeLessThan(types.indexOf("topic:switch"));
      const sw = h.broadcasts.find((b) => b.type === "topic:switch")!;
      expect(sw).toMatchObject({ fromTopicId: "cur", toTopicId: topicId, toSessionKey: created.sessionKey });
    } finally { h.cleanup(); }
  });

  test("400 when title missing, 404 when session unknown", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      expect((await h.call("POST", "/api/sessions/topic:cur/new-topic", {}))!.status).toBe(400);
      expect((await h.call("POST", "/api/sessions/topic:nobody/new-topic", { title: "x" }))!.status).toBe(404);
    } finally { h.cleanup(); }
  });
});

describe("POST /api/sessions/:sessionKey/create-project", () => {
  test("scaffolds workspace dir + CLAUDE.md, binds the topic, broadcasts topic:updated + pane:focus-suggest", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      const resp = (await h.call("POST", "/api/sessions/topic:cur/create-project", { name: "FreshProj" }))!;
      expect(resp.status).toBe(200);
      const { projectPath } = await resp.json();
      expect(projectPath).toBe(join(h.workspaceDir, "FreshProj"));
      expect(existsSync(projectPath)).toBe(true);
      expect(readFileSync(join(projectPath, "CLAUDE.md"), "utf-8")).toContain("FreshProj");
      expect(h.topics.get("cur")!.projectPath).toBe(projectPath);

      const updated = h.broadcasts.find((b) => b.type === "topic:updated");
      expect((updated?.topic as Topic | undefined)?.projectPath).toBe(projectPath);
      const focus = h.broadcasts.find((b) => b.type === "pane:focus-suggest");
      expect(focus).toMatchObject({ topicId: "cur", projectPath });
    } finally { h.cleanup(); }
  });

  test("409 (structured, naming the collision) when the project already exists — no bind, no broadcast", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      const dir = join(h.workspaceDir, "Taken");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), "# Taken\n");

      const resp = (await h.call("POST", "/api/sessions/topic:cur/create-project", { name: "Taken" }))!;
      expect(resp.status).toBe(409);
      const body = await resp.json();
      expect(body.error).toContain("Taken");
      expect(body.code).toBe("project_exists");
      expect(body.projectPath).toBe(dir);
      // The old behavior silently bound the topic to the existing dir — must not.
      expect(h.topics.get("cur")!.projectPath).toBeUndefined();
      expect(h.broadcasts).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("second create with the same name collides (create is not idempotent re-bind)", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      expect((await h.call("POST", "/api/sessions/topic:cur/create-project", { name: "Twice" }))!.status).toBe(200);
      expect((await h.call("POST", "/api/sessions/topic:cur/create-project", { name: "Twice" }))!.status).toBe(409);
    } finally { h.cleanup(); }
  });

  test("400 when name empty after sanitization, 404 when session unknown", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      expect((await h.call("POST", "/api/sessions/topic:cur/create-project", { name: "***" }))!.status).toBe(400);
      expect((await h.call("POST", "/api/sessions/topic:nobody/create-project", { name: "X" }))!.status).toBe(404);
    } finally { h.cleanup(); }
  });
});

describe("POST /api/sessions/:sessionKey/open-project", () => {
  test("resolves a known workspace project by name, binds + broadcasts", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      const dir = join(h.workspaceDir, "knownproj");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), "# knownproj\n"); // project marker

      const resp = (await h.call("POST", "/api/sessions/topic:cur/open-project", { ref: "knownproj" }))!;
      expect(resp.status).toBe(200);
      expect((await resp.json()).projectPath).toBe(dir);
      expect(h.topics.get("cur")!.projectPath).toBe(dir);
      expect(h.broadcasts.some((b) => b.type === "topic:updated")).toBe(true);
      expect(h.broadcasts.find((b) => b.type === "pane:focus-suggest")).toMatchObject({ topicId: "cur", projectPath: dir });
    } finally { h.cleanup(); }
  });

  test("404 for an unknown ref, and for a raw path Topics does not know (trustRawPaths:false)", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      expect((await h.call("POST", "/api/sessions/topic:cur/open-project", { ref: "no-such-proj" }))!.status).toBe(404);
      // /etc exists on disk but is not a known project — the AI path must refuse it.
      expect((await h.call("POST", "/api/sessions/topic:cur/open-project", { ref: "/etc" }))!.status).toBe(404);
      expect(h.broadcasts).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("404 when session unknown, 400 when ref missing", async () => {
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      expect((await h.call("POST", "/api/sessions/topic:nobody/open-project", { ref: "x" }))!.status).toBe(404);
      expect((await h.call("POST", "/api/sessions/topic:cur/open-project", {}))!.status).toBe(400);
    } finally { h.cleanup(); }
  });
});
