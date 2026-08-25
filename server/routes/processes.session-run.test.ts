/**
 * Gate coverage for the session-keyed run endpoint
 * (POST /api/sessions/:sessionKey/scripts/run) added for the MCP bridge.
 *
 * We mount the real processesRouter with a minimal stub AppContext and exercise
 * the validation/resolution branches that run BEFORE any process spawn — so no
 * `npm run` is ever launched. The happy path (actual spawn) is intentionally
 * not covered here to keep the suite side-effect free; it reuses the same
 * startScriptProcess as the long-standing UI endpoint.
 * @covers PROCESS-01
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createProcessesRouter } from "./processes";

type Topic = { id: string; sessionKey: string; projectPath?: string } | null;

function makeCtx(opts: { topic?: Topic; cwd?: string | null }) {
  return {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    broadcastToAll: () => {},
    getTopicBySessionKey: (_k: string): Topic => opts.topic ?? null,
    resolveTopicCwd: (_t: Topic) => (opts.cwd === undefined ? null : opts.cwd),
  } as any;
}

function runReq(router: any, sessionKey: string, body: unknown) {
  const path = `/api/sessions/${encodeURIComponent(sessionKey)}/scripts/run`;
  const req = new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return router(req, new URL(`http://x${path}`), path, "POST") as Promise<Response>;
}

describe("POST /api/sessions/:sessionKey/scripts/run — gate", () => {
  test("400 when scriptName missing", async () => {
    const router = createProcessesRouter(makeCtx({ topic: { id: "t", sessionKey: "s" } }));
    const resp = await runReq(router, "s", {});
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/scriptName.*required/i);
  });

  test("404 when no topic bound to the session", async () => {
    const router = createProcessesRouter(makeCtx({ topic: null }));
    const resp = await runReq(router, "ghost", { scriptName: "test" });
    expect(resp.status).toBe(404);
    expect((await resp.json()).error).toMatch(/no topic/i);
  });

  test("400 when topic has no project directory", async () => {
    const router = createProcessesRouter(makeCtx({ topic: { id: "t", sessionKey: "s" }, cwd: null }));
    const resp = await runReq(router, "s", { scriptName: "test" });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/no project directory/i);
  });

  // Da 33944fa5 il cancello guarda TUTTI i manifest, non solo `package.json`, e
  // la chiave con cui si lancia e l'id `<manifest>#<nome>` — serve perche `test`
  // di package.json e `test` del Makefile sono due comandi diversi. Cio che
  // questi due test tengono fermo non cambia: chiedere uno script che non
  // esiste da 400, e la risposta dice PERCHE.
  test("400 + elenco dei lanciabili quando lo script non e dichiarato", async () => {
    const dir = mkdtempSync(join(tmpdir(), "topics-run-gate-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", test: "playwright" } }));
      const router = createProcessesRouter(makeCtx({ topic: { id: "t", sessionKey: "s" }, cwd: dir }));
      const resp = await runReq(router, "s", { scriptName: "nope" });
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.error).toContain('"nope"');
      // Gli id, non i nomi nudi: e con quelli che si rilancia.
      expect(body.available).toEqual(["package.json#dev", "package.json#test"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("400 quando nella cartella non c'e NESSUN manifest, e dice quali ha guardato", async () => {
    const dir = mkdtempSync(join(tmpdir(), "topics-run-nopkg-"));
    try {
      const router = createProcessesRouter(makeCtx({ topic: { id: "t", sessionKey: "s" }, cwd: dir }));
      const resp = await runReq(router, "s", { scriptName: "test" });
      expect(resp.status).toBe(400);
      const error: string = (await resp.json()).error;
      // L'elenco di cosa ha cercato e la parte che rende leggibile l'assenza:
      // distingue «qui non c'e niente» da «non ho guardato».
      expect(error).toMatch(/nessun manifest/i);
      expect(error).toContain("package.json");
      expect(error).toContain("Makefile");
      expect(error).toContain("Cargo.toml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Cross-project isolation: a process started under session A's project must be
 * invisible to and un-stoppable from session B. Uses a real (harmless) spawn.
 */
describe("session-scoped process isolation", () => {
  // ctx that maps two distinct sessionKeys to two distinct working dirs.
  function multiCtx(map: Record<string, string>) {
    return {
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
      broadcastToAll: () => {},
      getTopicBySessionKey: (k: string) => (map[k] ? { id: k, sessionKey: k, projectPath: map[k] } : null),
      resolveTopicCwd: (t: any) => (t ? map[t.sessionKey] ?? null : null),
    } as any;
  }

  function call(router: any, method: string, fullPath: string, body?: unknown) {
    const u = new URL(`http://x${fullPath}`);
    const req = new Request(u.toString(), {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return router(req, u, u.pathname, method) as Promise<Response | null>;
  }

  test("project B cannot see, read, or stop project A's process", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "topics-iso-A-"));
    const dirB = mkdtempSync(join(tmpdir(), "topics-iso-B-"));
    writeFileSync(join(dirA, "package.json"), JSON.stringify({ scripts: { serve: "sleep 5" } }));
    writeFileSync(join(dirB, "package.json"), JSON.stringify({ scripts: { serve: "sleep 5" } }));
    const router = createProcessesRouter(multiCtx({ sa: dirA, sb: dirB }));

    try {
      // A starts a long-running process
      const runResp = (await call(router, "POST", "/api/sessions/sa/scripts/run", { scriptName: "serve", tty: false }))!;
      expect(runResp.status).toBe(200);
      const { processId } = await runResp.json();
      expect(processId).toBeTruthy();

      // A sees it; B does not
      const listA = await (await call(router, "GET", "/api/sessions/sa/scripts"))!.json();
      const listB = await (await call(router, "GET", "/api/sessions/sb/scripts"))!.json();
      expect(listA.scripts.some((s: any) => s.processId === processId)).toBe(true);
      expect(listB.scripts.some((s: any) => s.processId === processId)).toBe(false);

      // B cannot read A's output
      const outB = (await call(router, "GET", `/api/sessions/sb/scripts/${processId}/output`))!;
      expect(outB.status).toBe(404);
      // A can
      const outA = (await call(router, "GET", `/api/sessions/sa/scripts/${processId}/output`))!;
      expect(outA.status).toBe(200);

      // B cannot stop A's process
      const stopB = (await call(router, "POST", `/api/sessions/sb/scripts/${processId}/stop`))!;
      expect(stopB.status).toBe(404);
      // A can
      const stopA = (await call(router, "POST", `/api/sessions/sa/scripts/${processId}/stop`))!;
      expect(stopA.status).toBe(200);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
