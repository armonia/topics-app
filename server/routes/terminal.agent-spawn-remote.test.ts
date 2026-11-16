/**
 * The route wiring of SUBAGENT-25/26/27 into `spawn_agent`/`read_agent`
 * (SUBAGENT-28), end to end through the real terminal router: a child whose
 * cwd is a git repo with an origin, and a node with a free seat, is started
 * remotely, not as a local process; once the node's run reaches `review`,
 * its branch lands in the parent and the parent's row retires.
 *
 * @covers SUBAGENT-28
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { getSubagent, insertSubagent, markSubagentRemote } from "../lib/subagent-store";
import { bundleBranch } from "../services/branch-on-origin";
import { _setPtyBridgeSocketPath, createTerminalRouter, disconnectBridge } from "./terminal";
import type { AppContext } from "../types";

const AGENT_TOKEN = "f".repeat(64);
const originalTopicsHome = process.env.TOPICS_HOME;
const originalStandalone = process.env.TOPICS_DISABLE_PTY_BRIDGE;
let topicsHome: string | null = null;

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

  const ctx = baseCtx(tempRoot, machineId, "http://fake-node.test", {
    nodeClient: {
      readRun: async () => ({
        status: "review", dispatchState: null, dispatchError: null,
        comments: [{ id: "c-1", author: "agent", content: "done", kind: "assistant", createdAt: "2026-11-15T12:00:00.000Z" }],
        deliveryBranch: branch, deliveryCommit: null, baseSha: null, stat: null,
      }),
      fetchBundle: async () => ({ empty: false, bytes: bundleBytes! }),
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

    git(parentRepo, "checkout", "-q", branch);
    const { readFileSync } = await import("fs");
    expect(readFileSync(join(parentRepo, "b.txt"), "utf8")).toBe("from the child\n");
  } finally {
    try { closeDatabase(); } catch { /* best effort */ }
  }
});
