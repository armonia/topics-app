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
  * @covers TOPIC-CTRL-01
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTopicsRouter } from "./topics";
import type { Topic } from "../types";
import { projectHash } from "../../shared/project-keys";

// The terminal-tab fallback of open/create-project (and move-to-project) resolves
// the caller via getTerminalSessionById, which is imported statically from
// ./terminal and reads a module-private `sessions` Map only a live PTY bridge
// populates. Mock the module so a test can register a fake terminal session by id
// without standing up a bridge. registerTerminalSession(...) drives the mock;
// clearTerminalSessions() resets it between tests.
const terminalSessions = new Map<string, { id: string; name?: string }>();
function registerTerminalSession(id: string, name?: string) {
  terminalSessions.set(id, { id, name });
}
function clearTerminalSessions() {
  terminalSessions.clear();
}
mock.module("./terminal", () => ({
  getTerminalSessionById: (id: string) => terminalSessions.get(id),
}));

/**
 * Minimal in-memory stand-in for the SQLite `ui_state` table, faithful to the
 * subset the pane-move helper uses: `query(sql).get(...)` for a single-row read
 * (by key, or the MAX(server_seq) aggregate), `run(sql, params)` for the upsert,
 * and `transaction(fn).immediate()` (synchronous — the real BEGIN IMMEDIATE is
 * about seq collision under concurrency, not needed single-threaded in a test).
 * Backed by a plain Map so tests can assert the persisted rows directly.
 */
function makeUiStateDb() {
  const rows = new Map<string, { value: string; server_seq: number }>();
  const db = {
    query(sql: string) {
      if (/MAX\(server_seq\)/.test(sql)) {
        return {
          get: () => {
            let maxSeq = 0;
            for (const r of rows.values()) if (r.server_seq > maxSeq) maxSeq = r.server_seq;
            return { maxSeq };
          },
        };
      }
      // SELECT value FROM ui_state WHERE key = ?
      return { get: (key: string) => rows.get(key) };
    },
    run(_sql: string, params: unknown[]) {
      const [key, value, seq] = params as [string, string, number];
      rows.set(key, { value, server_seq: seq });
    },
    transaction<T>(fn: () => T) {
      const runner = () => fn();
      (runner as unknown as { immediate: () => T }).immediate = () => fn();
      return runner as (() => T) & { immediate: () => T };
    },
  };
  return { db, rows };
}

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
  const { db, rows: uiState } = makeUiStateDb();

  const ctx = {
    OPENCLAW_DIR: openclawDir,
    db,
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

  const readUi = (key: string): Record<string, unknown> | null => {
    const row = uiState.get(key);
    if (!row) return null;
    try { return JSON.parse(row.value) as Record<string, unknown>; } catch { return null; }
  };

  return { topics, broadcasts, workspaceDir, call, cleanup, uiState, readUi, projectHash };
}

// Terminal sessions live in a module-level Map behind the mock; reset it so one
// test's fake tab can't leak into the next.
beforeEach(() => { clearTerminalSessions(); });

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

  test("un ref di soli caratteri non ammessi NON lega la topic alla radice del workspace", async () => {
    // Il ramo di ultima risorsa faceva
    // `join(WORKSPACE_DIR, raw.replace(/[^a-zA-Z0-9_-]/g, ""))`. Con un ref
    // come «../..» lo slug esce VUOTO e `join(dir, "")` è `dir`: la directory
    // esiste, quindi la funzione restituiva la RADICE del workspace e ce la
    // legava. È la classe che il docstring di resolveProjectRef dice di parare
    // (prompt injection che emette {{PROJECT_OPEN:…}}), ed è raggiungibile
    // proprio sul percorso AI, perché una stringa così non inizia né con «/»
    // né con «~/» e non passa dal controllo sui path assoluti.
    const h = makeHarness();
    try {
      h.topics.set("cur", makeTopic({ id: "cur" }));
      for (const ref of ["../..", "..", "///", "@@@"]) {
        const resp = (await h.call("POST", "/api/sessions/topic:cur/open-project", { ref }))!;
        expect(resp.status, `ref ${JSON.stringify(ref)} deve essere rifiutato`).toBe(404);
      }
      expect(h.topics.get("cur")!.projectPath).toBeUndefined();
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

// --- Terminal Claude tab (no chat topic) --------------------------------------
// A terminal tab's MCP carries session-key = terminal UUID, so
// getTopicBySessionKey is null but getTerminalSessionById resolves. open/create
// -project fall back to moveTerminalPaneToProject (splice from pane-store-v2 →
// add to the project membership + broadcasts); switch/new return a structured
// 400 naming the right tool instead of a bare 404.

/** Seed a terminal pane in the app-level pane-store-v2, in a group, at seq 1. */
function seedTerminalPane(h: ReturnType<typeof makeHarness>, termId: string) {
  const paneId = `terminal:${termId}`;
  h.uiState.set("pane-store-v2", {
    value: JSON.stringify({
      panes: { [paneId]: { id: paneId, type: "terminal", title: "Claude Code", terminalType: "claude-code", scrollOffset: 42 } },
      groups: { g1: { paneIds: [paneId, "other:keep"] } },
    }),
    server_seq: 1,
  });
  return paneId;
}

describe("terminal Claude tab (session-key = terminal id, no chat topic)", () => {
  test("open-project: resolves a known project by NAME, splices the pane out of pane-store-v2, adds it to the project membership, broadcasts ui-state + open-project", async () => {
    const h = makeHarness();
    try {
      registerTerminalSession("term-abc", "my tab");
      const paneId = seedTerminalPane(h, "term-abc");
      const dir = join(h.workspaceDir, "yup");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), "# yup\n"); // project marker

      // Fix B: resolves by NAME (not an absolute path) — "apri il progetto yup".
      const resp = (await h.call("POST", "/api/sessions/term-abc/open-project", { ref: "yup" }))!;
      expect(resp.status).toBe(200);
      expect((await resp.json()).projectPath).toBe(dir);

      // Pane spliced out of the standalone store (both the panes entry and the
      // group ref), the sibling pane left intact.
      const app = h.readUi("pane-store-v2") as { panes: Record<string, unknown>; groups: Record<string, { paneIds: string[] }> };
      expect(app.panes[paneId]).toBeUndefined();
      expect(app.groups.g1.paneIds).toEqual(["other:keep"]);

      // Added to the project's server-synced membership under the exact hash key,
      // carrying the pane shape minus scrollOffset.
      const memKey = `topics-project-panes-${h.projectHash(dir)}`;
      const mem = h.readUi(memKey) as { nonChatPanes: Array<Record<string, unknown>> };
      expect(mem.nonChatPanes).toHaveLength(1);
      expect(mem.nonChatPanes[0]).toMatchObject({ id: paneId, type: "terminal", terminalType: "claude-code" });
      expect(mem.nonChatPanes[0].scrollOffset).toBeUndefined();

      // Broadcasts: a ui-state:updated for each key + a single open-project (focus).
      const uiKeys = h.broadcasts.filter((b) => b.type === "ui-state:updated").map((b) => b.key);
      expect(uiKeys).toContain("pane-store-v2");
      expect(uiKeys).toContain(memKey);
      expect(h.broadcasts.filter((b) => b.type === "open-project")).toMatchObject([{ projectPath: dir }]);
      // No chat-topic side effects.
      expect(h.broadcasts.some((b) => b.type === "topic:updated")).toBe(false);
    } finally { h.cleanup(); }
  });

  test("open-project: 404 for an unknown ref (the terminal path is NOT trustRawPaths — /etc is refused)", async () => {
    const h = makeHarness();
    try {
      registerTerminalSession("term-x");
      seedTerminalPane(h, "term-x");
      expect((await h.call("POST", "/api/sessions/term-x/open-project", { ref: "ghost" }))!.status).toBe(404);
      expect((await h.call("POST", "/api/sessions/term-x/open-project", { ref: "/etc" }))!.status).toBe(404);
      expect(h.broadcasts).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("open-project: idempotent — a second move of the SAME tab into the SAME project leaves exactly one membership entry", async () => {
    const h = makeHarness();
    try {
      registerTerminalSession("term-idem");
      const paneId = seedTerminalPane(h, "term-idem");
      const dir = join(h.workspaceDir, "idemproj");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), "# idemproj\n");

      // First move.
      expect((await h.call("POST", "/api/sessions/term-idem/open-project", { ref: "idemproj" }))!.status).toBe(200);
      const memKey = `topics-project-panes-${h.projectHash(dir)}`;
      let mem = h.readUi(memKey) as { nonChatPanes: Array<{ id: string }> };
      expect(mem.nonChatPanes.map((p) => p.id)).toEqual([paneId]);

      // Re-register the tab (a live tab still exists) and move again → no dup.
      registerTerminalSession("term-idem");
      expect((await h.call("POST", "/api/sessions/term-idem/open-project", { ref: "idemproj" }))!.status).toBe(200);
      mem = h.readUi(memKey) as { nonChatPanes: Array<{ id: string }> };
      expect(mem.nonChatPanes.map((p) => p.id)).toEqual([paneId]); // still exactly one
    } finally { h.cleanup(); }
  });

  test("create-project: scaffolds the dir + moves the terminal pane in + broadcasts open-project", async () => {
    const h = makeHarness();
    try {
      registerTerminalSession("term-c");
      const paneId = seedTerminalPane(h, "term-c");

      const resp = (await h.call("POST", "/api/sessions/term-c/create-project", { name: "FromTab" }))!;
      expect(resp.status).toBe(200);
      const dir = join(h.workspaceDir, "FromTab");
      expect((await resp.json()).projectPath).toBe(dir);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);

      // Pane moved into the new project's membership.
      const memKey = `topics-project-panes-${h.projectHash(dir)}`;
      const mem = h.readUi(memKey) as { nonChatPanes: Array<{ id: string }> };
      expect(mem.nonChatPanes.map((p) => p.id)).toEqual([paneId]);
      expect((h.readUi("pane-store-v2") as { panes: Record<string, unknown> }).panes[paneId]).toBeUndefined();
      expect(h.broadcasts.filter((b) => b.type === "open-project")).toMatchObject([{ projectPath: dir }]);
    } finally { h.cleanup(); }
  });

  test("create-project: 409 collision still holds from a terminal tab — no scaffold overwrite, no move, no broadcast", async () => {
    const h = makeHarness();
    try {
      registerTerminalSession("term-dup");
      seedTerminalPane(h, "term-dup");
      const dir = join(h.workspaceDir, "Taken");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), "# original\n");

      const resp = (await h.call("POST", "/api/sessions/term-dup/create-project", { name: "Taken" }))!;
      expect(resp.status).toBe(409);
      const body = await resp.json();
      expect(body.code).toBe("project_exists");
      expect(body.projectPath).toBe(dir);
      // Existing CLAUDE.md untouched; no pane move; no broadcast.
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("# original\n");
      expect((h.readUi("pane-store-v2") as { panes: Record<string, unknown> }).panes["terminal:term-dup"]).toBeDefined();
      expect(h.broadcasts).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("switch-topic: structured 400 (not 404) naming open_project/move_session_to_project", async () => {
    const h = makeHarness();
    try {
      registerTerminalSession("term-s");
      h.topics.set("tgt", makeTopic({ id: "tgt" }));
      const resp = (await h.call("POST", "/api/sessions/term-s/switch-topic", { topicId: "tgt" }))!;
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.code).toBe("not_a_chat_topic");
      expect(body.tool).toBe("switch_topic");
      expect(body.error).toMatch(/open_project/);
      expect(body.error).toMatch(/move_session_to_project/);
      expect(h.broadcasts.filter((b) => b.type === "topic:switch")).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("new-topic: structured 400 (not 404) naming open_project/move_session_to_project", async () => {
    const h = makeHarness();
    try {
      registerTerminalSession("term-n");
      const resp = (await h.call("POST", "/api/sessions/term-n/new-topic", { title: "x" }))!;
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.code).toBe("not_a_chat_topic");
      expect(body.tool).toBe("new_topic");
      expect(body.error).toMatch(/open_project/);
      expect(h.broadcasts.filter((b) => b.type === "topic:created")).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("still a bare 404 when the session is neither a chat topic NOR a terminal tab", async () => {
    const h = makeHarness();
    try {
      // No terminal registered, no topic — genuinely unbound.
      const sw = (await h.call("POST", "/api/sessions/nobody/switch-topic", { topicId: "x" }))!;
      expect(sw.status).toBe(404);
      const op = (await h.call("POST", "/api/sessions/nobody/open-project", { ref: "x" }))!;
      expect(op.status).toBe(404);
    } finally { h.cleanup(); }
  });
});

/**
 * Il ponte MCP del browser vive in `browser-bridge.ts`, ma è `topicsRouter` a
 * montarlo — e il montaggio è l'unico pezzo che i suoi test unitari non possono
 * vedere. Qui si prova solo QUELLO: che le rotte `…/browser/*` sono raggiungibili
 * attraverso il router intero, nella posizione giusta (nessuna rotta a cinque
 * segmenti le scavalca) e con `getTerminalSessionById` davvero collegato.
 */
describe("il ponte MCP del browser è montato dentro topicsRouter", () => {
  test("close-pane risolve la topic e chiede la chiusura del pannello", async () => {
    const h = makeHarness();
    try {
      h.topics.set("t1", makeTopic({ id: "t1" }));
      const resp = (await h.call("POST", "/api/topics/t1/browser/close-pane", {}))!;
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true, contextId: "t1" });
      expect(h.broadcasts.filter((b) => b.type === "browser:close-pane")).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  test("una sessionKey di TERMINALE arriva fino a term-<id>", async () => {
    const h = makeHarness();
    try {
      registerTerminalSession("77", "Terminal 77");
      const resp = (await h.call("POST", "/api/sessions/77/browser/close-pane", {}))!;
      expect(await resp.json()).toEqual({ ok: true, contextId: "term-77" });
    } finally { h.cleanup(); }
  });

  test("open-pane in una build senza browser ⇒ 503, non un 404 da rotta inesistente", async () => {
    const h = makeHarness();
    try {
      h.topics.set("t1", makeTopic({ id: "t1" }));
      const resp = (await h.call("POST", "/api/topics/t1/browser/open-pane", { url: "https://example.com/" }))!;
      // 503 = la rotta c'è ed è stata eseguita (questo harness monta
      // createTopicsRouter senza BrowserService). Un 404 vorrebbe dire che il
      // sotto-router non è montato o è coperto da un'altra rotta.
      expect(resp.status).toBe(503);
    } finally { h.cleanup(); }
  });

  test("un endpoint browser sconosciuto non viene ingoiato dal blocco generico", async () => {
    const h = makeHarness();
    try {
      h.topics.set("t1", makeTopic({ id: "t1" }));
      const resp = await h.call("POST", "/api/topics/t1/browser/inventata", {});
      expect(resp).toBeNull();
    } finally { h.cleanup(); }
  });
});

/**
 * L'IDENTITÀ DI UN PROGETTO È LA CARTELLA, NON LA STRADA PER ARRIVARCI.
 *
 * `projectIdForPath` è un hash della STRINGA del percorso: un topic legato a un
 * symlink e uno legato alla cartella vera diventano due progetti — due board, due
 * voci in sidebar, due pannelli. Successo il 02/09/2026 con
 * `~/.openclaw/workspace/neuture-proposal` → `~/Projects/neuture-proposal`.
 */
describe("POST /api/topics — il percorso si scioglie dal link", () => {
  test("un topic creato su un link risulta legato alla cartella vera", async () => {
    const h = makeHarness();
    try {
      const vero = join(h.workspaceDir, "progetto-vero");
      mkdirSync(vero, { recursive: true });
      const link = join(h.workspaceDir, "scorciatoia");
      symlinkSync(vero, link);

      const resp = (await h.call("POST", "/api/topics", { name: "dal link", projectPath: link }))!;
      expect(resp.status).toBe(201);
      const creato = (await resp.json()) as { projectPath: string };
      expect(creato.projectPath).toBe(realpathSync(vero));
      expect(creato.projectPath).not.toBe(link);
    } finally { h.cleanup(); }
  });

  test("una cartella che non esiste resta com'è: non è un errore", async () => {
    const h = makeHarness();
    try {
      const mai = join(h.workspaceDir, "non-creata-ancora");
      const resp = (await h.call("POST", "/api/topics", { name: "futura", projectPath: mai }))!;
      expect(((await resp.json()) as { projectPath: string }).projectPath).toBe(mai);
    } finally { h.cleanup(); }
  });
});
