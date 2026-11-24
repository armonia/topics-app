/**
 * The worktree routes of a node (`/api/nodes/worktrees`, `/worktree-policy`,
 * `/worktrees/gc`) and their primary half (`/api/machines/...`): who may call
 * them, a policy out of schema refused, a dry run that writes nothing, and a
 * node that does not speak the protocol skipped without a call.
 *
 * @covers WORKTREE-STD-11
 */
import { describe, expect, test } from "bun:test";
import type { AppContext } from "../types";
import type { Machine } from "../../shared/types";
import type { MachineWorktreeReport, WorktreeSummary } from "../../shared/worktree-summary";
import type { AppSettings } from "../services/app-settings";
import { createNodeWorktreesRouter, type NodeWorktreesDeps } from "./nodes-worktrees";
import { createMachineWorktreesRouter, machineWorktreeLines, type MachineWorktreesDeps } from "./machine-worktrees";
import { validateSettingsPatch } from "./app-settings";
import { NodeError } from "../services/node-client";

type Identity = { role: "owner" | "guest"; deviceId: string | null; delegatedAuthorizationId?: string } | null;

const SUMMARY: WorktreeSummary = {
  root: "/srv/wt", count: 3, bytes: 3_000_000_000, rootFreeGb: 40.5, foreign: 2, ghosts: 0, orphans: 1, scanMs: 12, at: "2026-11-24T10:00:00.000Z",
};

/** A database that knows one node credential and which device holds the channel. */
function fakeDb(nodeDevices: string[], channel: string | null) {
  return {
    query: (sql: string) => ({
      get: (arg?: unknown) => {
        if (sql.includes("FROM node_devices WHERE device_id")) return nodeDevices.includes(String(arg)) ? { one: 1 } : null;
        if (sql.includes("FROM primary_state")) return { channel_device_id: channel };
        return null;
      },
      all: () => nodeDevices.map((d) => ({ device_id: d, origin: "paired" })),
    }),
  };
}

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

function context(identity: Identity, db = fakeDb(["node-dev"], "node-dev")): AppContext {
  return {
    db,
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute,
    requestIdentity: () => identity,
  } as unknown as AppContext;
}

function nodeSide(identity: Identity, db?: ReturnType<typeof fakeDb>) {
  const effects: string[] = [];
  let settings: Partial<AppSettings> = { worktreeRoot: null, worktreeMaxPerProject: null, gcForeign: null };
  const deps: NodeWorktreesDeps = {
    summary: {
      current: () => { effects.push("summary"); return SUMMARY; },
      entries: () => [],
      refresh: async () => SUMMARY,
      invalidate: () => { effects.push("invalidate"); },
    },
    plan: async () => { effects.push("plan"); return { entries: [], foreignCount: 0, scanMs: 1, overCap: [] }; },
    runGc: async () => { effects.push("gc"); return { reaped: 1 }; },
    settings: () => settings,
    validate: (body) => validateSettingsPatch(body, [{ path: "/repos/app" }]),
    apply: (patch) => { effects.push(`apply:${JSON.stringify(patch)}`); settings = { ...settings, ...patch }; },
  };
  const router = createNodeWorktreesRouter(context(identity, db), () => deps);
  const call = (method: string, path: string, body?: unknown) => {
    const url = new URL(`https://node.test${path}`);
    return router(new Request(url, {
      method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), url, url.pathname, method) as Promise<Response | null>;
  };
  return { call, effects };
}

const OWNER: Identity = { role: "owner", deviceId: null };

describe("who may reach a node's worktrees", () => {
  test("a delegated credential is refused on all three routes, before any effect, even with an owner role", async () => {
    for (const role of ["owner", "guest"] as const) {
      const { call, effects } = nodeSide({ role, deviceId: null, delegatedAuthorizationId: "auth-1" });
      expect((await call("GET", "/api/nodes/worktrees"))!.status).toBe(403);
      expect((await call("PUT", "/api/nodes/worktree-policy", { maxPerProject: 30 }))!.status).toBe(403);
      expect((await call("POST", "/api/nodes/worktrees/gc"))!.status).toBe(403);
      expect(effects).toEqual([]);
    }
  });

  test("a guest is refused; a node credential that does not hold the channel is refused", async () => {
    const guest = nodeSide({ role: "guest", deviceId: "phone" });
    expect((await guest.call("GET", "/api/nodes/worktrees"))!.status).toBe(403);
    const other = nodeSide({ role: "owner", deviceId: "other-node" }, fakeDb(["node-dev", "other-node"], "node-dev"));
    expect((await other.call("POST", "/api/nodes/worktrees/gc"))!.status).toBe(403);
    expect([...guest.effects, ...other.effects]).toEqual([]);
  });

  test("the primary on its channel and the owner of the machine get the summary, with the capability", async () => {
    for (const identity of [{ role: "owner" as const, deviceId: "node-dev" }, OWNER]) {
      const { call } = nodeSide(identity);
      const res = (await call("GET", "/api/nodes/worktrees"))!;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ worktreeStandard: 1, summary: SUMMARY });
    }
    const listed = await (await nodeSide(OWNER).call("GET", "/api/nodes/worktrees?list=1"))!.json();
    expect(listed.entries).toEqual([]);
  });

  test("paths it does not own fall through", async () => {
    expect(await nodeSide(OWNER).call("GET", "/api/nodes/runs/x")).toBeNull();
  });
});

describe("the policy the primary sends", () => {
  test("out of schema = 400 and nothing written: unknown key, wrong type, bad value, empty, not an object", async () => {
    const { call, effects } = nodeSide(OWNER);
    const bad: unknown[] = [
      { bogus: 1 },
      { maxPerProject: "many" },
      { maxPerProject: { n: 3 } },
      { root: "/tmp/wt" },
      { root: "relative/wt" },
      { root: "/repos/app/wt" },
      { gcForeign: "everything" },
      { cargoTargetMode: "global" },
      { maxPerProject: 30, dryRun: "yes" },
      {},
      [1, 2],
      "not json",
    ];
    for (const body of bad) {
      const res = (await call("PUT", "/api/nodes/worktree-policy", body))!;
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(effects.filter((e) => e.startsWith("apply"))).toEqual([]);
    const refused = await (await call("PUT", "/api/nodes/worktree-policy", { root: "/tmp/wt" }))!.json();
    expect(refused.errors[0].field).toBe("root");
  });

  test("dryRun answers before and after and writes nothing", async () => {
    const { call, effects } = nodeSide(OWNER);
    const res = (await call("PUT", "/api/nodes/worktree-policy", { root: "/srv/wt", maxPerProject: 30, dryRun: true }))!;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.before.root).toBeNull();
    expect(body.after).toMatchObject({ root: "/srv/wt", maxPerProject: 30 });
    expect(effects).toEqual([]);
  });

  test("applied, it lands in this machine's settings and the summary is measured again", async () => {
    const { call, effects } = nodeSide(OWNER);
    const res = (await call("PUT", "/api/nodes/worktree-policy", { root: "/srv/wt", gcForeign: "merged" }))!;
    expect(res.status).toBe(200);
    expect((await res.json()).after).toMatchObject({ root: "/srv/wt", gcForeign: "merged" });
    expect(effects).toEqual([`apply:${JSON.stringify({ worktreeRoot: "/srv/wt", gcForeign: "merged" })}`, "invalidate"]);
  });
});

describe("the cleanup asked from the primary", () => {
  test("dryRun=1 is the preview: no pass runs", async () => {
    const { call, effects } = nodeSide(OWNER);
    const res = (await call("POST", "/api/nodes/worktrees/gc?dryRun=1"))!;
    expect(res.status).toBe(200);
    expect((await res.json()).dryRun).toBe(true);
    expect(effects).toEqual(["plan"]);
  });

  test("without dryRun it is the node's own pass, then a new measure", async () => {
    const { call, effects } = nodeSide(OWNER);
    expect((await call("POST", "/api/nodes/worktrees/gc"))!.status).toBe(200);
    expect(effects).toEqual(["gc", "invalidate"]);
  });
});

function machine(id: string, over: Partial<Machine> = {}): Machine {
  return {
    id, name: id, hostname: id, arch: "", platform: "", daemonVersion: "0", status: "online",
    lastHeartbeatAt: "", lastSeenAt: "", acknowledgedWarnings: {}, baseUrl: `http://${id}.test`, slots: null,
    createdAt: "", updatedAt: "", ...over,
  };
}

function primarySide(identity: Identity, reports: Record<string, MachineWorktreeReport | null>) {
  const calls: string[] = [];
  const deps: MachineWorktreesDeps = {
    local: () => ({ machine: machine("mac", { baseUrl: null }), summary: SUMMARY }),
    nodes: () => [machine("pc"), machine("old"), machine("new")],
    report: (id) => reports[id] ?? null,
    tokenOf: () => "tok",
    client: {
      putWorktreePolicy: async (input) => {
        calls.push(`policy:${input.baseUrl}:${input.dryRun === true}`);
        if (input.policy.root === "C:repo") throw new NodeError("rejected", "worktree policy answered 400", 400);
        return { dryRun: input.dryRun === true, before: {}, after: input.policy };
      },
      worktreeGc: async (input) => { calls.push(`gc:${input.baseUrl}:${input.dryRun === true}`); return { dryRun: input.dryRun === true }; },
    },
  };
  const router = createMachineWorktreesRouter(context(identity), () => deps);
  const call = (method: string, path: string, body?: unknown) => {
    const url = new URL(`https://primary.test${path}`);
    return router(new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), url, url.pathname, method) as Promise<Response | null>;
  };
  return { call, calls, deps };
}

describe("the primary's half", () => {
  const reports = { pc: { supported: true, summary: SUMMARY }, old: { supported: false, summary: null } };

  test("one line per machine: this one first, an old node marked, a silent one without a number", () => {
    const lines = machineWorktreeLines(primarySide(OWNER, reports).deps);
    expect(lines.map((l) => [l.machineId, l.local, l.supported, l.summary?.count ?? null])).toEqual([
      ["mac", true, true, 3], ["pc", false, true, 3], ["old", false, false, null], ["new", false, null, null],
    ]);
  });

  test("a node without the capability is skipped without a call and without an error", async () => {
    const { call, calls } = primarySide(OWNER, reports);
    for (const id of ["old", "new"]) {
      const res = (await call("PUT", `/api/machines/${id}/worktree-policy`, { maxPerProject: 30 }))!;
      expect(res.status).toBe(200);
      expect((await res.json()).skipped).toBe(true);
      expect((await call("POST", `/api/machines/${id}/worktree-gc?dryRun=1`))!.status).toBe(200);
    }
    expect(calls).toEqual([]);
  });

  test("an out-of-schema policy never leaves the primary; a value the node refuses comes back as 400", async () => {
    const { call, calls } = primarySide(OWNER, reports);
    expect((await call("PUT", "/api/machines/pc/worktree-policy", { rm: "/srv/wt/x" }))!.status).toBe(400);
    expect(calls).toEqual([]);
    expect((await call("PUT", "/api/machines/pc/worktree-policy", { root: "C:repo" }))!.status).toBe(400);
    expect((await call("PUT", "/api/machines/pc/worktree-policy", { root: "E:\\wt", dryRun: true }))!.status).toBe(200);
    expect((await call("POST", "/api/machines/pc/worktree-gc?dryRun=1"))!.status).toBe(200);
    expect(calls).toEqual(["policy:http://pc.test:false", "policy:http://pc.test:true", "gc:http://pc.test:true"]);
  });

  test("a delegated credential or a guest is refused before any node is called", async () => {
    for (const identity of [{ role: "owner" as const, deviceId: null, delegatedAuthorizationId: "a" }, { role: "guest" as const, deviceId: "g" }]) {
      const { call, calls } = primarySide(identity, reports);
      expect((await call("GET", "/api/machines/worktrees"))!.status).toBe(403);
      expect((await call("POST", "/api/machines/pc/worktree-gc"))!.status).toBe(403);
      expect(calls).toEqual([]);
    }
  });
});
