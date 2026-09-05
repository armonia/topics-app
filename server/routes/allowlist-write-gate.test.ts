/**
 * WHO MAY WRITE INTO THE PROJECT ALLOWLIST.
 *
 * `services/known-project-dirs.ts` is the boundary of every route that takes a
 * `path` from a client, and four of its six sources are written by a request:
 * a terminal cwd (closed on 2026-09-03), a registered project, a topic's
 * `projectPath`, a `project:` token inside `ui_state`. The three left open
 * reached the same place in TWO calls: register `~/.ssh` as a project, then
 * read it back through `/api/files/content`.
 *
 * The test measures the CONSEQUENCE, not the shape: after the refused call it
 * rebuilds the union FROM THE SAME SOURCES and asks the boundary whether the
 * file inside `~/.ssh` is reachable. A 400 that still left the row in the
 * store would pass a test on the status code, and not this one.
 *
 * The two counter-cases are half the point: from LOOPBACK (no paired device)
 * the same calls go through, and a paired device may still name a directory
 * INSIDE a project the server already knows. A gate that closes those too is
 * not stricter, it is broken.
 *
 * @covers PROJECT-11
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createProjectsRouter } from "./projects";
import { createTopicsRouter } from "./topics";
import { createUiStateRouter } from "./ui-state";
import { knownProjectDirs, isInsideKnownProject } from "../services/known-project-dirs";

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const pp = pattern.split("/"), xp = pathname.split("/");
  if (pp.length !== xp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
    else if (pp[i] !== xp[i]) return null;
  }
  return params;
}

const TOPIC_ID = "t1";
/** The paired device declares itself with a header, so a request without one
 *  is the LOOPBACK case: the same distinction `server.ts` draws with
 *  `requestIdentity`, cut down to what this file needs. */
const PAIRED = { "x-test-paired": "1" };

let root: string;
let openclawDir: string;
let workspaceDir: string;
let sshDir: string;
let projectDir: string;
let db: Database;
let ctx: AppContext;
let projectsRouter: ReturnType<typeof createProjectsRouter>;
let topicsRouter: ReturnType<typeof createTopicsRouter>;
let uiStateRouter: ReturnType<typeof createUiStateRouter>;
let created: Array<{ path: string }>;
let topics: Record<string, { id: string; name: string; projectPath?: string }>;
let homeBefore: string | undefined;

/** The union, rebuilt from the very sources the routes have written. */
function allowlist(): Set<string> {
  return knownProjectDirs({
    db: db as never,
    loadTopics: () => ({ topics: topics as Record<string, unknown> }),
    worktreeStore: { list: () => [] },
    projectStore: { list: () => created },
    workspaceDir,
  });
}

function reachable(path: string): boolean {
  return isInsideKnownProject(path, allowlist());
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const u = new URL(`http://x${url}`);
  const req = new Request(u, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
  return { req, u };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "allow-write-")));
  homeBefore = process.env.HOME;
  // A fake HOME: `~/.ssh` is the exact shape of the attack, and no test has
  // to go near the real home to show it.
  process.env.HOME = root;
  openclawDir = join(root, ".openclaw");
  workspaceDir = join(openclawDir, "workspace");
  sshDir = join(root, ".ssh");
  projectDir = join(root, "projects", "app");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(sshDir, { recursive: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(sshDir, "known_hosts"), "secret\n");

  db = new Database(":memory:");
  db.run(`CREATE TABLE terminal_sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL)`);
  db.run(`CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT, payload_version INTEGER DEFAULT 2, server_seq INTEGER DEFAULT 0, updated_at TEXT)`);

  created = [];
  // One KNOWN project is already there: it is what keeps the gate honest.
  topics = { [TOPIC_ID]: { id: TOPIC_ID, name: "one", projectPath: projectDir } };

  ctx = {
    db,
    OPENCLAW_DIR: openclawDir,
    loadTopics: () => ({ topics }),
    saveSingleTopic: (t: { id: string }) => { topics[t.id] = t as never; },
    getTopicById: (id: string) => topics[id] ?? null,
    worktreeStore: { list: () => [] },
    projectStore: {
      list: () => created,
      slugify: (n: string) => n.toLowerCase(),
      create: (p: { path: string }) => { created.push(p); return { id: "p1", ...p }; },
    },
    requestIdentity: (req: Request) =>
      req.headers.get("x-test-paired") ? { role: "owner" as const, deviceId: "dev-1" } : null,
    // The real boundary, not a stub: it is what the predicate asks.
    resolveProjectPath: (p: string) => {
      const expanded = p.startsWith("~") ? p.replace(/^~/, root) : p;
      let real = expanded;
      try { real = realpathSync(expanded); } catch { /* not on disk */ }
      return isInsideKnownProject(real, allowlist()) ? real : null;
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
    readJSON: (req: Request) => req.json().catch(() => null),
    matchRoute,
    errorResponse: (status: number, error: string) =>
      new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } }),
    slugify: (n: string) => n.toLowerCase(),
    broadcastToAll: () => {},
    broadcastProject: () => {},
    activeStreams: new Map(),
    isStreaming: () => false,
  } as unknown as AppContext;

  projectsRouter = createProjectsRouter(ctx);
  topicsRouter = createTopicsRouter(ctx);
  uiStateRouter = createUiStateRouter(ctx);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  if (homeBefore === undefined) delete process.env.HOME; else process.env.HOME = homeBefore;
});

function createProject(path: string, headers: Record<string, string> = {}) {
  const { req, u } = post("/api/projects", { name: "p", path }, headers);
  return projectsRouter(req, u, "/api/projects", "POST");
}

function bindTopic(path: string, headers: Record<string, string> = {}) {
  const u = new URL(`http://x/api/topics/${TOPIC_ID}`);
  const req = new Request(u, { method: "PATCH", body: JSON.stringify({ projectPath: path }), headers: { "Content-Type": "application/json", ...headers } });
  return topicsRouter(req, u, `/api/topics/${TOPIC_ID}`, "PATCH");
}

function putUiState(value: unknown, headers: Record<string, string> = {}) {
  const u = new URL("http://x/api/ui-state/panes");
  const req = new Request(u, { method: "PUT", body: JSON.stringify(value), headers: { "Content-Type": "application/json", ...headers } });
  return uiStateRouter(req, u, "/api/ui-state/panes", "PUT");
}

describe("the three doors that write the allowlist, from a PAIRED device", () => {
  test("POST /api/projects does not register `~/.ssh`, and the boundary keeps saying no", async () => {
    const res = (await createProject(sshDir, PAIRED))!;
    expect(res.status).toBe(400);
    expect(created).toEqual([]);
    expect(reachable(join(sshDir, "known_hosts"))).toBe(false);
  });

  test("PATCH /api/topics/:id does not bind a topic to `~/.ssh`", async () => {
    const res = (await bindTopic(sshDir, PAIRED))!;
    expect(res.status).toBe(400);
    expect(topics[TOPIC_ID].projectPath).toBe(projectDir);
    expect(reachable(join(sshDir, "known_hosts"))).toBe(false);
  });

  test("PUT /api/ui-state/:key refuses a `project:` token on `~/.ssh`", async () => {
    const res = (await putUiState({ a: `project:${sshDir}` }, PAIRED))!;
    expect(res.status).toBe(400);
    expect(db.query("SELECT value FROM ui_state WHERE key = 'panes'").get()).toBeNull();
    expect(reachable(join(sshDir, "known_hosts"))).toBe(false);
  });

  test("the percent-encoded token is the same token: the gate reads it as the source reads it", async () => {
    const res = (await putUiState({ a: `project:${encodeURIComponent(sshDir)}` }, PAIRED))!;
    expect(res.status).toBe(400);
    expect(reachable(join(sshDir, "known_hosts"))).toBe(false);
  });

  test("`~` is no way out: it expands before the verdict", async () => {
    // On the PATCH, where `canonicalProjectPath` expands the tilde and judges
    // nothing: without the gate the topic really did end up on `~/.ssh`.
    const res = (await bindTopic("~/.ssh", PAIRED))!;
    expect(res.status).toBe(400);
    expect(topics[TOPIC_ID].projectPath).toBe(projectDir);
    expect(reachable(join(sshDir, "known_hosts"))).toBe(false);
  });
});

describe("what the gate must NOT take away", () => {
  test("from loopback the same three calls go through", async () => {
    expect((await createProject(sshDir))!.status).not.toBe(400);
    expect(created.map(p => p.path)).toEqual([sshDir]);

    expect((await bindTopic(sshDir))!.status).toBe(200);
    expect((await putUiState({ a: `project:${sshDir}` }))!.status).toBe(200);
  });

  test("a paired device may still name a directory INSIDE a known project", async () => {
    const inside = join(projectDir, "src");
    expect((await createProject(inside, PAIRED))!.status).not.toBe(400);
    expect((await bindTopic(inside, PAIRED))!.status).toBe(200);
    expect((await putUiState({ a: `project:${inside}` }, PAIRED))!.status).toBe(200);
  });

  test("a token pointing at a VANISHED directory does not jam the UI sync", async () => {
    // It adds no root (`knownProjectDirs` realpaths it and drops it), so
    // refusing the write would freeze a device's whole state over a stale
    // snapshot while closing nothing.
    const gone = join(root, "projects", "cancellato");
    expect((await putUiState({ a: `project:${gone}` }, PAIRED))!.status).toBe(200);
    expect(reachable(gone)).toBe(false);
  });
});
