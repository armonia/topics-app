/**
 * Session-scoped task list (GET /api/sessions/:sessionKey/tasks) — integration.
 *
 * Boots a real schema via initDatabase into a tmpdir and drives the real
 * boards router for both writes and the scoped read, so we verify that an agent
 * only ever sees its own project's tasks. The router is given a minimal ctx
 * (real db + a verbatim copy of the app's matchRoute) plus a stubbed
 * getTopicBySessionKey mapping each session to a project path.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "../db";
import { createBoardsRouter } from "./boards";

let tmpRoot: string;
let router: any;

// Verbatim copy of AppContext.matchRoute (server/utils.ts) so route param
// extraction matches production behavior exactly.
function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

const SESSION_PROJECT: Record<string, string> = {
  sa: "/proj/alpha",
  sb: "/proj/beta",
};

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "boards-session-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  process.env.DATA_DIR = join(tmpRoot, "data");
  initDatabase(tmpRoot);

  const db = getDatabase();
  const ctx: any = {
    db,
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute,
    errorResponse: (status: number, message: string) =>
      new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } }),
    broadcastToAll: () => {},
    getTopicBySessionKey: (k: string) =>
      SESSION_PROJECT[k] ? { id: k, sessionKey: k, projectPath: SESSION_PROJECT[k] } : null,
  };
  router = createBoardsRouter(ctx);
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function call(method: string, fullPath: string, body?: unknown) {
  const u = new URL(`http://x${fullPath}`);
  const req = new Request(u.toString(), {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return router(req, u, u.pathname, method) as Promise<Response | null>;
}

describe("GET /api/sessions/:sessionKey/tasks", () => {
  test("returns only the session project's tasks", async () => {
    // Seed two projects via the real POST endpoint.
    await call("POST", `/api/boards/${encodeURIComponent("/proj/alpha")}/tasks`, { text: "alpha-1" });
    await call("POST", `/api/boards/${encodeURIComponent("/proj/alpha")}/tasks`, { text: "alpha-2" });
    await call("POST", `/api/boards/${encodeURIComponent("/proj/beta")}/tasks`, { text: "beta-1" });

    const aResp = (await call("GET", "/api/sessions/sa/tasks"))!;
    expect(aResp.status).toBe(200);
    const a = await aResp.json();
    expect(a.projectId).toBe("/proj/alpha");
    expect(a.tasks.map((t: any) => t.text).sort()).toEqual(["alpha-1", "alpha-2"]);

    const bResp = (await call("GET", "/api/sessions/sb/tasks"))!;
    const b = await bResp.json();
    expect(b.tasks.map((t: any) => t.text)).toEqual(["beta-1"]);
  });

  test("forwards status filter", async () => {
    await call("POST", `/api/boards/${encodeURIComponent("/proj/alpha")}/tasks`, { text: "alpha-done", status: "done" });
    const resp = (await call("GET", "/api/sessions/sa/tasks?status=done"))!;
    const body = await resp.json();
    expect(body.tasks.every((t: any) => t.status === "done")).toBe(true);
    expect(body.tasks.some((t: any) => t.text === "alpha-done")).toBe(true);
  });

  test("404 when session has no bound topic", async () => {
    const resp = (await call("GET", "/api/sessions/ghost/tasks"))!;
    expect(resp.status).toBe(404);
  });
});
