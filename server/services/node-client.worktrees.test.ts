/**
 * The primary's side of a node's worktrees: the capability read from
 * `/api/version`, the three calls the client makes, the heartbeat that stores
 * the summary (and skips an older node without asking it), the read-model in
 * `machines.worktree_summary`, and the node's summary measured from its
 * cleanup preview without ever making the heartbeat wait.
 *
 * @covers WORKTREE-STD-11
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Machine } from "../../shared/types";
import type { MachineWorktreeReport, WorktreeSummary } from "../../shared/worktree-summary";
import type { WorktreePlanPayload } from "../../shared/worktree-plan";
import { EMBEDDED_MIGRATIONS } from "../db/migrations-embedded";
import { createNodeClient, NodeError, type FetchLike, type NodeClient } from "./node-client";
import { createNodeProbe } from "./node-heartbeat";
import { createMachineStore } from "./machine-store";
import { createWorktreeSummarySource, summarizePlan } from "./worktree-summary";

const BASE = "https://node.example:8443";

function recordingClient(answer: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => { calls.push({ url, init: init ?? {} }); return answer(url, init ?? {}); };
  const c = createNodeClient({ fetch, now: () => 0, wait: async () => {}, version: "9.9.9", hostname: "primary" });
  return { c, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SUMMARY: WorktreeSummary = {
  root: "/srv/wt", count: 2, bytes: 10, rootFreeGb: 5, foreign: 1, ghosts: 0, orphans: 0, scanMs: 3, at: "2026-11-24T10:00:00.000Z",
};

describe("the capability and the three calls", () => {
  test("readVersion says whether the node speaks the worktree routes", async () => {
    const now = recordingClient(() => json({ version: "2.9.0", worktreeStandard: 1 }));
    expect(await now.c.readVersion({ baseUrl: BASE, token: "t" })).toEqual({ version: "2.9.0", worktreeStandard: true });
    const old = recordingClient(() => json({ version: "2.8.0" }));
    expect(await old.c.readVersion({ baseUrl: BASE, token: "t" })).toEqual({ version: "2.8.0", worktreeStandard: false });
  });

  test("summary, policy and cleanup go to the node routes with the node cookie and never a delegation", async () => {
    const { c, calls } = recordingClient((url) => {
      if (url.includes("/api/nodes/worktree-policy")) return json({ ok: true, dryRun: true, before: { root: null }, after: { root: "E:\\wt" } });
      if (url.includes("/worktrees/gc")) return json({ dryRun: true, plan: { entries: [] } });
      return json({ worktreeStandard: 1, summary: SUMMARY, entries: [] });
    });
    expect(await c.worktreeSummary({ baseUrl: BASE, token: "t" })).toEqual({ summary: SUMMARY });
    expect(await c.worktreeSummary({ baseUrl: BASE, token: "t", list: true })).toEqual({ summary: SUMMARY, entries: [] });
    expect(await c.putWorktreePolicy({ baseUrl: BASE, token: "t", policy: { root: "E:\\wt" }, dryRun: true }))
      .toEqual({ dryRun: true, before: { root: null }, after: { root: "E:\\wt" } });
    await c.worktreeGc({ baseUrl: BASE, token: "t", dryRun: true });
    expect(calls.map((x) => `${x.init.method} ${x.url.slice(BASE.length)}`)).toEqual([
      "GET /api/nodes/worktrees",
      "GET /api/nodes/worktrees?list=1",
      "PUT /api/nodes/worktree-policy",
      "POST /api/nodes/worktrees/gc?dryRun=1",
    ]);
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ root: "E:\\wt", dryRun: true });
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Cookie).toBe("topics_device=t");
      expect(headers["X-Topics-Delegated-Capability"]).toBeUndefined();
    }
  });

  test("a policy the node refuses is a `rejected` failure, not a network one", async () => {
    const { c } = recordingClient(() => json({ error: "invalid worktree policy", code: "invalid_input" }, 400));
    const err = await c.putWorktreePolicy({ baseUrl: BASE, token: "t", policy: { root: "C:repo" } }).catch((e) => e);
    expect(err).toBeInstanceOf(NodeError);
    expect((err as NodeError).reason).toBe("rejected");
  });
});

function machine(id: string): Machine {
  return {
    id, name: id, hostname: id, arch: "", platform: "", daemonVersion: "0", status: "online", lastHeartbeatAt: "",
    lastSeenAt: "", acknowledgedWarnings: {}, baseUrl: `http://${id}.test`, slots: null, createdAt: "", updatedAt: "",
  };
}

describe("the heartbeat stores what the node reports", () => {
  test("a node without the capability is recorded as old and never asked; a current one gives its summary", async () => {
    const rows = [machine("current"), machine("old"), machine("silent")];
    const asked: string[] = [];
    const recorded: Array<[string, MachineWorktreeReport]> = [];
    const client: Pick<NodeClient, "readRun" | "readVersion" | "worktreeSummary"> = {
      readRun: async () => { throw new NodeError("not_found", "nf", 404); },
      readVersion: async ({ baseUrl }) => {
        if (baseUrl.includes("silent")) throw new Error("no version route");
        return { version: "2.9.0", worktreeStandard: baseUrl.includes("current") };
      },
      worktreeSummary: async ({ baseUrl }) => { asked.push(baseUrl); return { summary: SUMMARY }; },
    };
    const probe = createNodeProbe({
      list: () => rows,
      client,
      tokenOf: () => "tok",
      touch: (id) => rows.find((r) => r.id === id)!,
      onRefreshed: () => {},
      recordReported: () => null,
      recordWorktreeReport: (id, report) => { recorded.push([id, report]); },
      isCloud: () => false,
    });
    probe();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(asked).toEqual(["http://current.test"]);
    expect(recorded.sort()).toEqual([
      ["current", { supported: true, summary: SUMMARY }],
      ["old", { supported: false, summary: null }],
    ]);
  });

  test("machines.worktree_summary keeps the last report, written only when it changed", () => {
    const db = new Database(":memory:");
    for (const m of EMBEDDED_MIGRATIONS) db.run(m.sql);
    const store = createMachineStore(db, process.cwd());
    const node = store.upsertNode({ hostname: "pc:3393", name: "PC", baseUrl: "http://127.0.0.1:3393" });
    expect(store.worktreeReport(node.id)).toBeNull();
    store.recordWorktreeReport(node.id, { supported: true, summary: SUMMARY });
    expect(store.worktreeReport(node.id)).toEqual({ supported: true, summary: SUMMARY });
    const changes = () => (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    store.recordWorktreeReport(node.id, { supported: true, summary: SUMMARY });
    expect(changes() - before).toBe(0);
    store.recordWorktreeReport(node.id, { supported: true, summary: { ...SUMMARY, count: 3 } });
    expect(changes() - before).toBe(1);
  });

  test("a database older than the column answers null and does not throw", () => {
    const db = new Database(":memory:");
    for (const m of EMBEDDED_MIGRATIONS.filter((x) => !x.name.includes("machines-worktree-summary"))) db.run(m.sql);
    const store = createMachineStore(db, process.cwd());
    const node = store.upsertNode({ hostname: "pc:3393", name: "PC", baseUrl: "http://127.0.0.1:3393" });
    expect(() => store.recordWorktreeReport(node.id, { supported: false, summary: null })).not.toThrow();
    expect(store.worktreeReport(node.id)).toBeNull();
  });
});

const PLAN: WorktreePlanPayload = {
  entries: [
    { absPath: "/srv/wt/p/a", projectId: "p", projectName: "p", rowId: "w1", cls: "tracked", rootAction: "judge", plannedAction: "keep", reason: "", bytes: 1_000 },
    { absPath: "/srv/wt/p/b", projectId: "p", projectName: "p", rowId: null, cls: "orphan", rootAction: "register", plannedAction: null, reason: "", bytes: 500 },
    { absPath: "/srv/wt/p/c", projectId: null, projectName: null, rowId: null, cls: "ghost", rootAction: "wait", plannedAction: null, reason: "", bytes: 20 },
    { absPath: "/elsewhere/x", projectId: "p", projectName: "p", rowId: null, cls: "foreign", rootAction: "inventory", plannedAction: null, reason: "", bytes: 9_999 },
  ],
  foreignCount: 1,
  scanMs: 7,
  overCap: [],
};

describe("the node's summary", () => {
  test("worktrees, weight under the root, free space, outside the root, ghosts and orphans", () => {
    expect(summarizePlan(PLAN, "/srv/wt", 41.27, new Date("2026-11-24T10:00:00.000Z"))).toEqual({
      root: "/srv/wt", count: 2, bytes: 1_520, rootFreeGb: 41.3, foreign: 1, ghosts: 1, orphans: 1, scanMs: 7, at: "2026-11-24T10:00:00.000Z",
    });
  });

  test("never makes the heartbeat wait: null first, the measure after, one measure at a time, a new one when stale", async () => {
    let clock = 0;
    let measures = 0;
    let release: () => void = () => {};
    const source = createWorktreeSummarySource({
      plan: async ({ weigh }) => {
        expect(weigh).toBe(true);
        measures += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return PLAN;
      },
      root: () => "/srv/wt",
      freeGb: () => 10,
      now: () => clock,
      ttlMs: 1_000,
    });
    expect(source.current()).toBeNull();
    expect(source.current()).toBeNull();
    expect(measures).toBe(1);
    release();
    await source.refresh();
    expect(source.current()?.count).toBe(2);
    expect(measures).toBe(1);
    clock = 1_000;
    expect(source.current()?.count).toBe(2);
    expect(measures).toBe(2);
    release();
  });
});
