/**
 * The route wiring of SUBAGENT-25/26/27 into `spawn_agent`/`read_agent`
 * (SUBAGENT-28), end to end through the real terminal router: a child whose
 * cwd is a git repo with an origin, and a node with a free seat, is started
 * remotely, not as a local process; once the node's run reaches `review`,
 * its branch lands in the parent and the parent's row retires.
 *
 * @covers SUBAGENT-28
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as net from "net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { getSubagent, insertSubagent, markSubagentRemote } from "../lib/subagent-store";
import { SETTLE_TRIES, createRemoteSubagentWiring } from "../lib/subagent-remote-wiring";
import { bundleBranch } from "../services/branch-on-origin";
import { openPauseIfNeeded } from "../services/project-pause";
import { projectIdOfFolder } from "../usage/project-folders";
import { createTerminalRouter, disconnectBridge } from "./terminal";
import { _setPtyBridgeSocketPath } from "./terminal-bridge-socket";
import type { AppContext } from "../types";

const AGENT_TOKEN = "f".repeat(64);
const originalTopicsHome = process.env.TOPICS_HOME;
const originalStandalone = process.env.TOPICS_DISABLE_PTY_BRIDGE;
let topicsHome: string | null = null;

// A remote child never opens a PTY, but the router's boot `ensureBridge()` would start a REAL bridge,
// whose log lands in the real /tmp (CI 16/11: the unit gate's "a test writes outside TMPDIR"). A fake one on a
// socket stands in, the same way `terminal.agent-spawn.test.ts` does.
let fakeBridge: net.Server | null = null;
beforeEach(async () => {
  const socketPath = `/tmp/tcs-${crypto.randomUUID().slice(0, 8)}.sock`;
  fakeBridge = net.createServer(() => {});
  await new Promise<void>((ok, ko) => { fakeBridge!.once("error", ko); fakeBridge!.listen(socketPath, ok); });
  _setPtyBridgeSocketPath(socketPath);
});
afterEach(() => { fakeBridge?.close(); fakeBridge = null; });

afterEach(() => {
  if (originalTopicsHome === undefined) delete process.env.TOPICS_HOME;
  else process.env.TOPICS_HOME = originalTopicsHome;
  if (topicsHome) rmSync(topicsHome, { recursive: true, force: true });
  topicsHome = null;
  // Inert while disconnecting (its own reconnect must not start a real bridge later), then restored.
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  disconnectBridge();
  if (originalStandalone === undefined) delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  else process.env.TOPICS_DISABLE_PTY_BRIDGE = originalStandalone;
  _setPtyBridgeSocketPath(null);
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

function baseCtx(tempRoot: string, machineId: string, machineBaseUrl: string, overrides: Partial<AppContext> = {}) {
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
    getTopicBySessionKey: () => null,
    machineStore: {
      list: () => [{ id: machineId, name: "node", status: "online" as const, baseUrl: machineBaseUrl, slots: 2 }],
      get: (id: string) => (id === machineId ? { baseUrl: machineBaseUrl } : null),
    },
    ...overrides,
  } as unknown as AppContext;
}

test("a child that needs this Mac (a browser) or asks an unknown runtime never starts a node run", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-spawn-remote-stay-"));
  topicsHome = join(tempRoot, "topics-home");
  mkdirSync(topicsHome, { recursive: true });
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;
  mkdirSync(join(tempRoot, "state", "nodes"), { recursive: true });
  const machineId = "node-fake-stay";
  writeFileSync(join(tempRoot, "state", "nodes", `${machineId}.token`), "t".repeat(32));
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);

  const origin = join(tempRoot, "origin.git");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare");
  const childRepo = join(tempRoot, "repo");
  git(tempRoot, "clone", "-q", origin, "repo");
  writeFileSync(join(childRepo, "a.txt"), "base\n");
  git(childRepo, "add", ".");
  git(childRepo, "commit", "-q", "-m", "base");
  git(childRepo, "push", "-q", "origin", "HEAD");

  let created = 0;
  const ctx = baseCtx(tempRoot, machineId, "http://fake-node.test", {
    nodeClient: { createRun: async () => { created += 1; return { runId: "run-x" }; } },
  } as unknown as Partial<AppContext>);

  try {
    const router = createTerminalRouter(ctx);
    const url = new URL("http://topics.test/api/sessions/pty%3Aparent-stay/agents/spawn");
    const spawn = (body: Record<string, unknown>) => router(
      new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-daemon-token": AGENT_TOKEN }, body: JSON.stringify({ cwd: childRepo, ...body }) }),
      url, url.pathname, "POST",
    );
    // Whatever the local path answers (it may well refuse in this bare test context), the node is never asked.
    await spawn({ prompt: "open the page in the browser and take a screenshot" });
    expect(created).toBe(0);
    const unknown = await spawn({ prompt: "refactor a.txt", runtime: "foo" });
    expect(created).toBe(0);
    expect(unknown?.status).toBe(400);
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
  }
});

test("a spawn in a git repo with origin and a free node starts remotely, never a local process", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-spawn-remote-"));
  topicsHome = join(tempRoot, "topics-home");
  mkdirSync(topicsHome, { recursive: true });
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;
  mkdirSync(join(tempRoot, "state", "nodes"), { recursive: true });
  const machineId = "node-fake-spawn";
  writeFileSync(join(tempRoot, "state", "nodes", `${machineId}.token`), "t".repeat(32));
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);

  const origin = join(tempRoot, "origin.git");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare");
  const childRepo = join(tempRoot, "repo");
  git(tempRoot, "clone", "-q", origin, "repo");
  writeFileSync(join(childRepo, "a.txt"), "base\n");
  git(childRepo, "add", ".");
  git(childRepo, "commit", "-q", "-m", "base");
  git(childRepo, "push", "-q", "origin", "HEAD");

  const calls: unknown[] = [];
  const ctx = baseCtx(tempRoot, machineId, "http://fake-node.test", {
    nodeClient: { createRun: async (input: unknown) => { calls.push(input); return { runId: "run-9" }; } },
  } as unknown as Partial<AppContext>);

  try {
    const router = createTerminalRouter(ctx);
    const url = new URL("http://topics.test/api/sessions/pty%3Aparent/agents/spawn");
    const response = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-daemon-token": AGENT_TOKEN },
        body: JSON.stringify({ prompt: "do it", cwd: childRepo }),
      }),
      url, url.pathname, "POST",
    );
    expect(response?.status).toBe(200);
    const body = await response!.json() as { agentId: string; branch: string; runtime: string; notify: string; runInBackground: boolean };
    expect(body.runtime).toBe("topics");
    expect(body.branch).toMatch(/^topics-child-/);
    expect(body.notify).toBe("read_agent");
    expect(body.runInBackground).toBe(true);

    const row = getSubagent(getDatabase(), body.agentId);
    expect(row?.remoteMachineId).toBe(machineId);
    expect(row?.remoteRunId).toBe("run-9");
    expect(row?.state).toBe("running");

    expect(calls).toHaveLength(1);
    const createRunBody = (calls[0] as { body: { baseBranch?: string | null; branchBundle?: string } }).body;
    expect(createRunBody.baseBranch).toBe(body.branch);
    expect(typeof createRunBody.branchBundle).toBe("string");
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
  }
});

test("isolation:'worktree' never takes the remote fast path, even with a free node (WORKTREE-17)", async () => {
  // Before the fix, the remote path ran first regardless of `isolation` and
  // answered with `cwd` = the PARENT's own checkout and `branch` = the
  // snapshot name used to cut the node's bundle, never a worktree: the exact
  // shape of the production-checkout bug this test guards against.
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-spawn-remote-isolation-"));
  topicsHome = join(tempRoot, "topics-home");
  mkdirSync(topicsHome, { recursive: true });
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;
  mkdirSync(join(tempRoot, "state", "nodes"), { recursive: true });
  const machineId = "node-fake-isolation";
  writeFileSync(join(tempRoot, "state", "nodes", `${machineId}.token`), "t".repeat(32));
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);

  const origin = join(tempRoot, "origin.git");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare");
  const childRepo = join(tempRoot, "repo");
  git(tempRoot, "clone", "-q", origin, "repo");
  writeFileSync(join(childRepo, "a.txt"), "base\n");
  git(childRepo, "add", ".");
  git(childRepo, "commit", "-q", "-m", "base");
  git(childRepo, "push", "-q", "origin", "HEAD");

  let created = 0;
  const ctx = baseCtx(tempRoot, machineId, "http://fake-node.test", {
    nodeClient: { createRun: async () => { created += 1; return { runId: "run-should-not-happen" }; } },
    // No project owns this directory in this bare test context: the local
    // worktree path must refuse with an error, never fall through to the node.
    projectStore: { getByPath: () => null },
    worktreeStore: { getByAbsPath: () => null },
  } as unknown as Partial<AppContext>);

  try {
    const router = createTerminalRouter(ctx);
    const url = new URL("http://topics.test/api/sessions/pty%3Aparent-isolation/agents/spawn");
    const response = await router(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-daemon-token": AGENT_TOKEN },
        body: JSON.stringify({ prompt: "do it", cwd: childRepo, isolation: "worktree" }),
      }),
      url, url.pathname, "POST",
    );
    // The node is never asked for an isolated child...
    expect(created).toBe(0);
    // ...and with no worktree, the call fails outright: never a 200 with the
    // parent's own cwd and a branch that is not a worktree.
    expect(response?.status).not.toBe(200);
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
  }
});

test("read_agent on a review'd remote child adopts its branch and retires the row (the round trip, SUBAGENT-26/28)", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-spawn-remote-settle-"));
  topicsHome = join(tempRoot, "topics-home");
  mkdirSync(topicsHome, { recursive: true });
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;
  const machineId = "node-fake-settle";
  mkdirSync(join(tempRoot, "state", "nodes"), { recursive: true });
  writeFileSync(join(tempRoot, "state", "nodes", `${machineId}.token`), "t".repeat(32));
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);

  const parentRepo = join(tempRoot, "parent");
  mkdirSync(parentRepo, { recursive: true });
  git(parentRepo, "init", "-q", "-b", "main");
  writeFileSync(join(parentRepo, "a.txt"), "base\n");
  git(parentRepo, "add", ".");
  git(parentRepo, "commit", "-q", "-m", "base");

  // Stands in for the node's own checkout: commits the child's work on its branch.
  const nodeRepo = join(tempRoot, "node-checkout");
  git(tempRoot, "clone", "-q", parentRepo, "node-checkout");
  const branch = "topics-child-settle-1";
  git(nodeRepo, "checkout", "-q", "-b", branch);
  writeFileSync(join(nodeRepo, "b.txt"), "from the child\n");
  git(nodeRepo, "add", ".");
  git(nodeRepo, "commit", "-q", "-m", "child work");
  const bundleBytes = await bundleBranch(nodeRepo, branch);
  expect(bundleBytes).not.toBeNull();

  const agentId = crypto.randomUUID();
  const parentKey = "pty:settle-parent";
  insertSubagent(getDatabase(), {
    id: agentId, parentSessionKey: parentKey, name: "remote child", model: null, agentType: null, effort: null,
    promptSnippet: "do it on the node", cwd: parentRepo, branch, claudeSessionId: null, createdAt: new Date().toISOString(),
  });
  markSubagentRemote(getDatabase(), agentId, { machineId, runId: "run-settle-1" });
  const archived: string[] = [];

  const ctx = baseCtx(tempRoot, machineId, "http://fake-node.test", {
    nodeClient: {
      readRun: async () => ({
        status: "review", dispatchState: null, dispatchError: null,
        comments: [{ id: "c-1", author: "agent", content: "done", kind: "assistant", createdAt: "2026-11-15T12:00:00.000Z" }],
        deliveryBranch: branch, deliveryCommit: null, baseSha: null, stat: null,
      }),
      fetchBundle: async () => ({ empty: false, bytes: bundleBytes! }),
      cancelRun: async (input: { runId: string }) => { archived.push(input.runId); },
    },
  } as unknown as Partial<AppContext>);

  try {
    const router = createTerminalRouter(ctx);
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(parentKey)}/agents/${agentId}/read`);
    const response = await router(
      new Request(url, { method: "GET", headers: { "x-daemon-token": AGENT_TOKEN } }),
      url, url.pathname, "GET",
    );
    expect(response?.status).toBe(200);

    const row = getSubagent(getDatabase(), agentId);
    expect(row?.state).toBe("retired");

    // Read from the object store, not a checkout: autocrlf on a Windows runner rewrites the file.
    expect(git(parentRepo, "show", `${branch}:b.txt`)).toBe("from the child");
    // Home, so the node's card is archived and its worktree can go (16/11: 130 left on the PC).
    expect(archived).toEqual(["run-settle-1"]);
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
  }
});

test("a node that never answers again frees the child's cap seat after the give-up window, as lost", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-spawn-remote-mute-"));
  const machineId = "node-fake-mute";
  mkdirSync(join(tempRoot, "state", "nodes"), { recursive: true });
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);
  const agentId = crypto.randomUUID();
  insertSubagent(getDatabase(), {
    id: agentId, parentSessionKey: "pty:mute-parent", name: "remote child", model: null, agentType: null, effort: null,
    promptSnippet: "do it on the node", cwd: tempRoot, branch: null, claudeSessionId: null, createdAt: new Date().toISOString(),
  });
  markSubagentRemote(getDatabase(), agentId, { machineId, runId: "run-mute-1" });
  let window = 60_000;
  const road = () => ({
    baseUrlOf: () => "http://fake-node.test", tokenOf: () => "t".repeat(32),
    readRun: async () => { throw new Error("connect ECONNREFUSED"); },
    createRun: async () => ({ runId: "x" }), fetchBundle: async () => { throw new Error("unused"); },
  });
  try {
    const ctx = baseCtx(tempRoot, machineId, "http://fake-node.test", {});
    const slow = createRemoteSubagentWiring(ctx, road as never, window);
    await slow.settleIfDone(getSubagent(getDatabase(), agentId)!);
    // A short silence (a PC asleep) keeps the child running.
    expect(getSubagent(getDatabase(), agentId)?.state).toBe("running");
    window = 0;
    const fast = createRemoteSubagentWiring(ctx, road as never, window);
    await fast.settleIfDone(getSubagent(getDatabase(), agentId)!);
    expect(getSubagent(getDatabase(), agentId)?.state).toBe("lost");
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
  }
});

test("a bundle that does not arrive keeps the child running and its work recoverable, never a fake 'completed'", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-spawn-remote-miss-"));
  topicsHome = join(tempRoot, "topics-home");
  mkdirSync(topicsHome, { recursive: true });
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;
  const machineId = "node-fake-miss";
  mkdirSync(join(tempRoot, "state", "nodes"), { recursive: true });
  writeFileSync(join(tempRoot, "state", "nodes", `${machineId}.token`), "t".repeat(32));
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);

  const parentRepo = join(tempRoot, "parent");
  mkdirSync(parentRepo, { recursive: true });
  git(parentRepo, "init", "-q", "-b", "main");
  writeFileSync(join(parentRepo, "a.txt"), "base\n");
  git(parentRepo, "add", ".");
  git(parentRepo, "commit", "-q", "-m", "base");

  const agentId = crypto.randomUUID();
  const parentKey = "pty:miss-parent";
  insertSubagent(getDatabase(), {
    id: agentId, parentSessionKey: parentKey, name: "remote child", model: null, agentType: null, effort: null,
    promptSnippet: "do it on the node", cwd: parentRepo, branch: "topics-child-miss-1", claudeSessionId: null, createdAt: new Date().toISOString(),
  });
  markSubagentRemote(getDatabase(), agentId, { machineId, runId: "run-miss-1" });

  let fetches = 0;
  const ctx = baseCtx(tempRoot, machineId, "http://fake-node.test", {
    nodeClient: {
      readRun: async () => ({
        status: "review", dispatchState: null, dispatchError: null,
        comments: [{ id: "c-1", author: "agent", content: "done", kind: "assistant", createdAt: "2026-11-15T12:00:00.000Z" }],
        deliveryBranch: "topics-child-miss-1", deliveryCommit: null, baseSha: null, stat: null,
      }),
      fetchBundle: async () => { fetches += 1; throw new Error("connection reset"); },
    },
  } as unknown as Partial<AppContext>);

  try {
    const router = createTerminalRouter(ctx);
    const url = new URL(`http://topics.test/api/sessions/${encodeURIComponent(parentKey)}/agents/${agentId}/read`);
    const read = () => router(new Request(url, { method: "GET", headers: { "x-daemon-token": AGENT_TOKEN } }), url, url.pathname, "GET");

    expect((await read())?.status).toBe(200);
    // One failed fetch: still running, so the next read or watch tick fetches again.
    expect(getSubagent(getDatabase(), agentId)?.state).toBe("running");

    for (let i = 1; i < SETTLE_TRIES; i++) await read();
    // Out of tries: the parent hears "failed" (state lost), not "completed" with a branch that does not exist.
    expect(fetches).toBe(SETTLE_TRIES);
    expect(getSubagent(getDatabase(), agentId)?.state).toBe("lost");
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
  }
});

test("spawn_agent in a paused project is refused before any worktree or process (limiti-consumo-progetto, USAGE-29)", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "agent-spawn-paused-"));
  topicsHome = join(tempRoot, "topics-home");
  mkdirSync(topicsHome, { recursive: true });
  writeFileSync(join(topicsHome, "daemon-state.json"), JSON.stringify({ pid: 1, port: 1, token: AGENT_TOKEN, startedAt: "x" }));
  process.env.TOPICS_HOME = topicsHome;
  initDatabase(resolve(import.meta.dir, "../.."), tempRoot);

  const childRepo = join(tempRoot, "repo");
  mkdirSync(childRepo, { recursive: true });

  const projectId = projectIdOfFolder(getDatabase(), childRepo);
  openPauseIfNeeded(getDatabase(), projectId, 999);

  let created = 0;
  const ctx = baseCtx(tempRoot, "node-unused", "http://fake-node.test", {
    machineStore: { list: () => [], get: () => null },
    nodeClient: { createRun: async () => { created += 1; return { runId: "run-x" }; } },
  } as unknown as Partial<AppContext>);

  try {
    const router = createTerminalRouter(ctx);
    const url = new URL("http://topics.test/api/sessions/pty%3Aparent-paused/agents/spawn");
    const res = await router(
      new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-daemon-token": AGENT_TOKEN }, body: JSON.stringify({ cwd: childRepo, prompt: "do something" }) }),
      url, url.pathname, "POST",
    );
    expect(res?.status).toBe(429);
    expect(await res?.json()).toMatchObject({ error: "In pausa: limite del progetto" });
    expect(created).toBe(0); // never asked a node, let alone started a local process
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
  }
});
