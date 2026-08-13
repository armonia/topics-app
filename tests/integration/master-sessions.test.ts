/**
 * interactive-claude-primitive — the Master must be able to READ, WRITE, and
 * CLOSE active sessions. This exercises those three primitives end-to-end
 * against the real PTY bridge using disposable SHELL sessions (free, local, no
 * `claude` / no API cost). It does NOT touch any pre-existing user session: it
 * creates fresh test sessions in an isolated DATA_DIR and deletes them.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { RouteHandler } from "../../server/types";

const TEST_DATA = testTmpDir("master-sessions");
// /send + /buffer are token-gated (agentAuthOk checks process.env.GATEWAY_TOKEN);
// set a known token for this in-process router and present it on every call().
const TEST_TOKEN = "test-token";
const PRIOR_GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
beforeAll(() => { process.env.GATEWAY_TOKEN = TEST_TOKEN; setupTestDataDir(TEST_DATA); });

let disconnect: (() => void) | null = null;
afterAll(() => {
  if (PRIOR_GATEWAY_TOKEN === undefined) delete process.env.GATEWAY_TOKEN;
  else process.env.GATEWAY_TOKEN = PRIOR_GATEWAY_TOKEN;
  try { disconnect?.(); } catch {}
});

function call(router: RouteHandler, method: string, path: string, body?: unknown) {
  const url = new URL("http://h" + path);
  const req = new Request(url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      "x-gateway-token": process.env.GATEWAY_TOKEN ?? TEST_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return router(req, url, url.pathname, method);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Master session control — read / write / close (shell sessions)", () => {
  test("creates a shell session, writes to it, reads its buffer, then closes it", async () => {
    const { createTerminalRouter, disconnectBridge } = await import("../../server/routes/terminal");
    const ctx = await createTestAppContext();
    const router = createTerminalRouter(ctx);
    disconnect = disconnectBridge;

    // --- CREATE a fresh shell test session (no claude → free) ---
    const createResp = await call(router, "POST", "/api/terminal/sessions", {
      name: "master-test-shell",
      type: "shell",
      cwd: "/tmp",
    });
    expect(createResp).not.toBeNull();
    if (createResp!.status === 502 || createResp!.status === 503) {
      // Nessun ponte PTY qui — si salta invece di fallire a vuoto. Due codici,
      // due assenze diverse, stessa conclusione:
      //   502 = il ponte non è riuscito a NASCERE (node-pty senza una sessione
      //         usabile: le sandbox di CI spesso non ce l'hanno);
      //   503 = il ponte è SPENTO per costruzione — «terminals not available in
      //         standalone mode», cioè TOPICS_DISABLE_PTY_BRIDGE/TOPICS_EMBEDDED
      //         (vedi `isPtyBridgeDisabled`). Nessuno dei due dice niente sul
      //         codice in prova.
      // Mancava il 503, e bastava un worktree senza bridge per tingere di rosso
      // una suite sana: misurato l'11/08 su main, unico rosso di 7147 test.
      console.warn(`[master-sessions] ponte PTY assente (${createResp!.status}) — salto le asserzioni sui PTY vivi`);
      return;
    }
    expect(createResp!.status).toBe(200);
    const { id } = (await createResp!.json()) as { id: string };
    expect(id).toBeTruthy();

    // Let the shell come up.
    await sleep(800);

    // --- WRITE: send a command the Master could issue ---
    const marker = "MASTER_CAN_WRITE_" + id.slice(0, 6);
    const sendResp = await call(router, "POST", `/api/terminal/sessions/${id}/send`, {
      input: `echo ${marker}\n`,
    });
    expect(sendResp!.status).toBe(200);
    expect((await sendResp!.json() as { ok: boolean }).ok).toBe(true);

    // --- READ: poll the buffer until the echoed marker appears ---
    let buffer = "";
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const bufResp = await call(router, "GET", `/api/terminal/sessions/${id}/buffer`);
      expect(bufResp!.status).toBe(200);
      buffer = (await bufResp!.json() as { buffer: string }).buffer;
      if (buffer.includes(marker)) break;
    }
    expect(buffer).toContain(marker);

    // --- CLOSE: delete the session ---
    const delResp = await call(router, "DELETE", `/api/terminal/sessions/${id}`);
    expect(delResp!.status).toBe(200);
    expect((await delResp!.json() as { ok: boolean }).ok).toBe(true);

    // --- verify it's gone from the list ---
    const listResp = await call(router, "GET", "/api/terminal/sessions");
    const list = (await listResp!.json()) as { sessions?: { id: string }[] } | { id: string }[];
    const arr = Array.isArray(list) ? list : (list.sessions ?? []);
    expect(arr.find((s) => s.id === id)).toBeUndefined();
  }, 20000);
});
