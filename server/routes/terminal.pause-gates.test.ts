/**
 * Doors B4 and B8 of the project pause, through the real terminal router:
 * `spawn_agent` and `send_to_agent` belong to the project of whoever LAUNCHES
 * (the parent chat), not the folder the child is pointed at. A paused project
 * starts no child turn: a spawn is refused (429), a send is HELD and goes out
 * on "Continua". @covers USAGE-29
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as net from "net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { insertSubagent } from "../lib/subagent-store";
import { resetHeldChildSendsForTests } from "../lib/held-child-send";
import { continueProject } from "../services/project-pause";
import { openPauseWithLimit } from "../../tests/helpers/paused-project";
import { fireProjectResumed, heldCount, resetHeldForTests } from "../services/turn-gate";
import { projectIdOfFolder } from "../usage/project-folders";
import { createTerminalRouter, disconnectBridge } from "./terminal";
import { _setPtyBridgeSocketPath } from "./terminal-bridge-socket";
import type { AppContext } from "../types";

const AGENT_TOKEN = "e".repeat(64);
const PARENT_KEY = "topic:pausepar";
const PARENT_TOPIC_ID = "pause-parent-topic";
const originalTopicsHome = process.env.TOPICS_HOME;
const originalStandalone = process.env.TOPICS_DISABLE_PTY_BRIDGE;
let tempRoot = "";
let fakeBridge: net.Server | null = null;

beforeEach(async () => {
  resetHeldForTests();
  resetHeldChildSendsForTests();
  const socketPath = `/tmp/tcs-${crypto.randomUUID().slice(0, 8)}.sock`;
  fakeBridge = net.createServer(() => {});
  await new Promise<void>((ok, ko) => { fakeBridge!.once("error", ko); fakeBridge!.listen(socketPath, ok); });
  _setPtyBridgeSocketPath(socketPath);
  tempRoot = mkdtempSync(join(tmpdir(), "terminal-pause-gates-"));
  const topicsHome = join(tempRoot, "topics-home");
  mkdirSync(topicsHome, { recursive: true });
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);
});
afterEach(() => {
  try { closeDatabase(); } catch { /* best effort */ }
  fakeBridge?.close();
  fakeBridge = null;
  if (originalTopicsHome === undefined) delete process.env.TOPICS_HOME;
  else process.env.TOPICS_HOME = originalTopicsHome;
  rmSync(tempRoot, { recursive: true, force: true });
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  disconnectBridge();
  if (originalStandalone === undefined) delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  else process.env.TOPICS_DISABLE_PTY_BRIDGE = originalStandalone;
  _setPtyBridgeSocketPath(null);
});

function makeCtx(): AppContext {
  return {
    STATE_DIR: join(tempRoot, "state"),
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    errorResponse: (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } }),
    readJSON: (request: Request) => request.json(),
    matchRoute: (pathname: string, pattern: string) => {
      const path = pathname.split("/");
      const route = pattern.split("/");
      if (path.length !== route.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < route.length; i++) {
        if (route[i]!.startsWith(":")) params[route[i]!.slice(1)] = decodeURIComponent(path[i]!);
        else if (route[i] !== path[i]) return null;
      }
      return params;
    },
    broadcastToAll: () => {},
    worktreeStore: {},
    resolveTopicCwd: () => null,
    getTopicBySessionKey: (key: string) => (key === PARENT_KEY ? { id: PARENT_TOPIC_ID, sessionKey: PARENT_KEY } : null),
    machineStore: { list: () => [], get: () => null },
  } as unknown as AppContext;
}

/** The parent chat lives in a project of its own; the returned id is the project's. */
function parentInProject(folderName: string): { folder: string; projectId: string } {
  const folder = join(tempRoot, folderName);
  mkdirSync(folder, { recursive: true });
  const now = new Date().toISOString();
  getDatabase().prepare("INSERT INTO topics (id, name, slug, session_key, project_path, created_at, updated_at) VALUES (?, 'Parent', 'parent', ?, ?, ?, ?)")
    .run(PARENT_TOPIC_ID, PARENT_KEY, folder, now, now);
  return { folder, projectId: projectIdOfFolder(getDatabase(), folder) };
}

const call = (router: ReturnType<typeof createTerminalRouter>, path: string, body: Record<string, unknown>) => {
  const url = new URL(`http://topics.test${path}`);
  return router(
    new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-daemon-token": AGENT_TOKEN }, body: JSON.stringify(body) }),
    url, url.pathname, "POST",
  );
};

test("spawn_agent: the paused project is the parent chat's, even when the child is pointed at another folder", async () => {
  const { projectId } = parentInProject("proj-paused");
  openPauseWithLimit(getDatabase(), projectId, 999);
  const elsewhere = join(tempRoot, "unpaused-elsewhere");
  mkdirSync(elsewhere, { recursive: true });

  const router = createTerminalRouter(makeCtx());
  const res = await call(router, `/api/sessions/${encodeURIComponent(PARENT_KEY)}/agents/spawn`, { cwd: elsewhere, prompt: "do something" });
  expect(res?.status).toBe(429);
  expect(await res?.json()).toMatchObject({ error: "In pausa: limite del progetto" });
  expect(getDatabase().query("SELECT COUNT(*) AS n FROM subagents").get()).toEqual({ n: 0 }); // no child row, no process
});

test("send_to_agent: a paused project holds the message (zero turns), and Continua sends it through the same route", async () => {
  const { projectId } = parentInProject("proj-paused-send");
  // A native child with no chat: when the route is reached past the gate it answers an error, which the resume logs.
  insertSubagent(getDatabase(), {
    id: "child-held", parentSessionKey: PARENT_KEY, name: "worker", model: null, agentType: null, effort: null,
    promptSnippet: "work", cwd: tempRoot, branch: null, claudeSessionId: null, createdAt: new Date().toISOString(), runtime: "topics",
  });
  openPauseWithLimit(getDatabase(), projectId, 999);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const router = createTerminalRouter(makeCtx());
    const path = `/api/sessions/${encodeURIComponent(PARENT_KEY)}/agents/child-held/send`;
    const first = await call(router, path, { input: "keep going" });
    expect(first?.status).toBe(202);
    expect(await first?.json()).toMatchObject({ ok: true, held: true, code: "project_paused", sent: 0 });
    expect(heldCount(projectId)).toBe(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("[held-child-send]"))).toHaveLength(0);

    continueProject(getDatabase(), projectId, 999);
    fireProjectResumed(projectId);
    for (let i = 0; i < 50 && warn.mock.calls.every((c) => !String(c[0]).includes("[held-child-send]")); i++) await new Promise((r) => setTimeout(r, 20));
    // Past the gate the route reached the child (here: no chat to run it on, so a refusal): the held message was sent.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("[held-child-send] child-held: the resumed message was refused"))).toBe(true);
    expect(heldCount(projectId)).toBe(0);
  } finally {
    warn.mockRestore();
  }
});

test("send_to_agent to a child this caller does not own is not parked: it answers as before", async () => {
  const { projectId } = parentInProject("proj-paused-foreign");
  openPauseWithLimit(getDatabase(), projectId, 999);
  const router = createTerminalRouter(makeCtx());
  const res = await call(router, `/api/sessions/${encodeURIComponent(PARENT_KEY)}/agents/nobody/send`, { input: "hi" });
  expect(res?.status).toBe(404);
  expect(heldCount(projectId)).toBe(0);
});

test("spawn_agent: a parent in a running project is not refused because the child is pointed at a paused folder", async () => {
  parentInProject("proj-running");
  const pausedFolder = join(tempRoot, "paused-elsewhere");
  mkdirSync(pausedFolder, { recursive: true });
  openPauseWithLimit(getDatabase(), projectIdOfFolder(getDatabase(), pausedFolder), 999);

  const router = createTerminalRouter(makeCtx());
  // `model` unknown: the call is refused later, by the launch checks, which proves the brake let it through without starting anything.
  const res = await call(router, `/api/sessions/${encodeURIComponent(PARENT_KEY)}/agents/spawn`, { cwd: pausedFolder, prompt: "do something", model: "no-such-model-xyz" });
  expect(res?.status).toBe(400);
  expect(JSON.stringify(await res?.json())).not.toContain("In pausa");
});
