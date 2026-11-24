/**
 * The registration door's routes and who may open them: a process on this
 * machine with the hook token. No token, a wrong one, a delegated node
 * credential, a guest or a call addressed to another host is refused before any
 * effect runs.
 *
 * @covers WORKTREE-STD-08
 */
import { describe, expect, test } from "bun:test";
import { createWorktreesRouter } from "./worktrees";
import type { AppContext } from "../types";
import type { RegisterDeps } from "../services/worktree-register";

const TOKEN = "ab".repeat(32);
type Identity = { role: "owner" | "guest"; deviceId: string | null; delegatedAuthorizationId?: string } | null;

function build(identity: Identity = { role: "owner", deviceId: null }) {
  const effects: string[] = [];
  const sent: unknown[] = [];
  const rows = new Map<string, { id: string; projectId: string; absPath: string }>();
  const ctx = {
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    readJSON: async (req: Request) => req.json(),
    matchRoute: () => null,
    errorResponse: (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status }),
    worktreeStore: { get: (id: string) => [...rows.values()].find((r) => r.id === id) ?? null },
    worktreeManager: {},
    broadcastToAll: (m: unknown) => { sent.push(m); },
    requestIdentity: () => identity,
  } as unknown as AppContext;
  const deps = (): RegisterDeps => ({
    platform: "darwin",
    roots: () => ["/r"],
    canonical: (p) => p.replace(/\/+$/, ""),
    projectFor: (p) => (p.startsWith("/repo") || p.startsWith("/r/repo") ? { id: "p1", slug: "repo", path: "/repo" } : null),
    isLinkedWorktree: () => true,
    exists: (p) => p !== "/r/repo/gone",
    headBranch: async () => "worktree-x",
    store: {
      list: () => [...rows.values()] as never,
      getByAbsPath: (p) => (rows.get(p) ?? null) as never,
      listNamesForProject: () => new Set<string>(),
      create: (input) => { effects.push(`create:${input.absPath}`); const r = { id: `w${rows.size + 1}`, projectId: input.projectId, absPath: input.absPath }; rows.set(input.absPath, r); return r as never; },
      update: () => { effects.push("update"); return null; },
      delete: (id) => { effects.push(`delete:${id}`); for (const [k, v] of rows) if (v.id === id) rows.delete(k); return true; },
    },
    readMarker: () => null,
    writeMarker: (p) => { effects.push(`marker:${p}`); return true; },
    machine: () => "h",
  });
  const router = createWorktreesRouter(ctx, { registration: { deps, token: () => TOKEN } });
  const call = (method: string, path: string, opts: { body?: unknown; auth?: string | null; host?: string } = {}) => {
    const headers: Record<string, string> = { host: opts.host ?? "127.0.0.1:3333", "content-type": "application/json" };
    if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${TOKEN}`;
    const url = new URL(`https://${headers.host}${path}`);
    return router(new Request(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), url, url.pathname, method);
  };
  return { call, effects, sent, rows };
}

const REGISTER = { path: "/r/repo/x", creator: "claude-code", session: { id: "s1" } };

describe("who may open the registration door", () => {
  test("no token, a wrong token, or a token of another shape: 401 and no effect", async () => {
    const { call, effects } = build();
    expect((await call("POST", "/api/worktrees/register", { body: REGISTER, auth: null }))!.status).toBe(401);
    expect((await call("POST", "/api/worktrees/register", { body: REGISTER, auth: `Bearer ${"cd".repeat(32)}` }))!.status).toBe(401);
    expect((await call("POST", "/api/worktrees/register", { body: REGISTER, auth: `Bearer ${TOKEN}x` }))!.status).toBe(401);
    expect((await call("GET", "/api/worktrees/placement?repo=/repo", { auth: null }))!.status).toBe(401);
    expect((await call("POST", "/api/worktrees/unregister", { body: { path: "/r/repo/gone" }, auth: null }))!.status).toBe(401);
    expect(effects).toEqual([]);
  });

  test("a delegated node credential is refused even with the right token", async () => {
    const { call, effects } = build({ role: "guest", deviceId: null, delegatedAuthorizationId: "auth-1" });
    const res = await call("POST", "/api/worktrees/register", { body: REGISTER });
    expect(res!.status).toBe(403);
    expect((await res!.json()).error).toMatch(/delegated/);
    expect(effects).toEqual([]);
  });

  test("a guest is refused even with the right token", async () => {
    const { call, effects } = build({ role: "guest", deviceId: "d1" });
    expect((await call("POST", "/api/worktrees/register", { body: REGISTER }))!.status).toBe(403);
    expect(effects).toEqual([]);
  });

  test("a call addressed to another host is refused: the worktree lives on this machine", async () => {
    const { call, effects } = build();
    expect((await call("POST", "/api/worktrees/register", { body: REGISTER, host: "topics.example.test" }))!.status).toBe(403);
    expect(effects).toEqual([]);
  });

  test("this machine with the hook token: the row is made and the clients are told", async () => {
    const { call, effects, sent } = build();
    const res = await call("POST", "/api/worktrees/register", { body: REGISTER });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ id: "w1", class: "tracked", inRoot: true, created: true });
    expect(effects).toEqual(["create:/r/repo/x", "update", "marker:/r/repo/x"]);
    expect(sent[0]).toMatchObject({ type: "worktree:new", worktree: { id: "w1" } });
    // Idempotent: the second call creates nothing and announces nothing.
    const again = await call("POST", "/api/worktrees/register", { body: REGISTER });
    expect(await again!.json()).toMatchObject({ id: "w1", created: false });
    expect(sent).toHaveLength(1);
  });
});

describe("the three routes", () => {
  test("an unknown repository answers 202 and writes nothing", async () => {
    const { call, effects } = build();
    const res = await call("POST", "/api/worktrees/register", { body: { path: "/r/other/y", creator: "codex" } });
    expect(res!.status).toBe(202);
    expect(effects).toEqual([]);
  });

  test("placement names the root and the slug", async () => {
    const { call } = build();
    const res = await call("GET", "/api/worktrees/placement?repo=/repo/.git");
    expect(await res!.json()).toEqual({ root: "/r", slug: "repo", projectId: "p1" });
  });

  test("unregister: refused while the folder stands, the row goes once it is gone", async () => {
    const { call, rows, sent } = build();
    await call("POST", "/api/worktrees/register", { body: REGISTER });
    expect((await call("POST", "/api/worktrees/unregister", { body: { path: "/r/repo/x" } }))!.status).toBe(409);
    rows.set("/r/repo/gone", { id: "w9", projectId: "p1", absPath: "/r/repo/gone" });
    const res = await call("POST", "/api/worktrees/unregister", { body: { path: "/r/repo/gone" } });
    expect(await res!.json()).toEqual({ removed: true, id: "w9" });
    expect(sent.at(-1)).toMatchObject({ type: "worktree:deleted", worktree: { id: "w9" } });
  });

  test("a host without the door answers 501", async () => {
    const ctx = { errorResponse: (s: number, m: string) => new Response(m, { status: s }) } as unknown as AppContext;
    const router = createWorktreesRouter(ctx, {});
    const url = new URL("https://127.0.0.1/api/worktrees/register");
    expect((await router(new Request(url, { method: "POST" }), url, url.pathname, "POST"))!.status).toBe(501);
  });
});
