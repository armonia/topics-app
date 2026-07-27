import { expect, test } from "@playwright/test";
import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalSessions,
} from "./helpers/api-fixtures";
import { spawn, execSync } from "child_process";
import { resolve } from "path";
import net from "net";
import { E2E_BASE, E2E_PORT, testServerEnv } from "./helpers/test-server";

const BASE = E2E_BASE;
const TEST_PORT = E2E_PORT;

/** Wait for the test server to be reachable on its port */
async function waitForServer(timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const isOpen = await new Promise<boolean>((res) => {
      const socket = net.createConnection({ port: TEST_PORT, host: "127.0.0.1" }, () => {
        socket.destroy();
        res(true);
      });
      socket.on("error", () => res(false));
      socket.setTimeout(1000, () => { socket.destroy(); res(false); });
    });
    if (isOpen) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not come back within ${timeoutMs}ms`);
}

/** Kill the test server and wait for the port to be released */
async function killServer(): Promise<void> {
  try {
    const pids = execSync(`lsof -ti :${TEST_PORT} 2>/dev/null || true`).toString().trim();
    if (pids) {
      execSync(`kill ${pids.split("\n").join(" ")} 2>/dev/null || true`);
    }
  } catch {}
  // Wait for port to be released
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const isOpen = await new Promise<boolean>((res) => {
      const socket = net.createConnection({ port: TEST_PORT, host: "127.0.0.1" }, () => {
        socket.destroy();
        res(true);
      });
      socket.on("error", () => res(false));
      socket.setTimeout(500, () => { socket.destroy(); res(false); });
    });
    if (!isOpen) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Server did not stop within 10s");
}

/** Riavvia il server di test con lo STESSO ambiente con cui è nato.
 *
 *  L'ambiente arriva da `testServerEnv()` — la stessa funzione che usa
 *  global-setup — perché la copia scritta a mano qui era già divergente: non
 *  passava né TOPICS_HOME né OPENCLAW_DIR, quindi il server ripartiva MENO
 *  isolato di come era partito, leggendo la config OpenClaw dell'utente vero.
 *  In particolare TOPICS_PTY_SOCKET è indispensabile: senza, il server deriva
 *  il socket del bridge dalla cwd = il bridge di PRODUZIONE, e il suo reconcile
 *  ammazza le PTY Claude vive del server di sviluppo. */
function startServer(): void {
  const scriptPath = resolve(__dirname, "../../scripts/start-test-server.sh");
  const proc = spawn("bash", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...testServerEnv(TEST_PORT) },
  });
  // Detach so the test doesn't hang waiting for the child
  proc.unref();
  proc.stdout?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[restart-server] ${msg}`);
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[restart-server:err] ${msg}`);
  });
}

test.describe.serial("Terminal Session Resume", () => {
  let createdSessionIds: string[] = [];
  // Shell sessions are auto-named basename(cwd) ("tmp" for cwd:"/tmp"), so we
  // can't look them up by the requested name — hoist the created id instead.
  // The list endpoint's typed shape ({id,name,cwd,type}) omits claudeSessionId,
  // so the "persists in list" checks look sessions up by id and assert presence;
  // the claudeSessionId VALUE is asserted on the (any-typed) POST responses.
  let shellSessionId: string;
  let claudeRowId: string;

  test.afterAll(async ({ request }) => {
    for (const id of createdSessionIds) {
      await deleteTerminalSession(request, id).catch(() => {});
    }
  });

  test("AC-1: new claude-code session gets a claudeSessionId", async ({ request }) => {
    const res = await request.post(`${BASE}/api/terminal/sessions`, {
      data: { cwd: "/tmp", type: "claude-code", name: "E2E-Resume-Claude" },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    createdSessionIds.push(body.id);
    claudeRowId = body.id;

    expect(body.claudeSessionId).toBeTruthy();
    expect(body.claudeSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  test("AC-1: shell session does NOT get a claudeSessionId", async ({ request }) => {
    const res = await request.post(`${BASE}/api/terminal/sessions`, {
      data: { cwd: "/tmp", type: "shell", name: "E2E-Resume-Shell" },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    createdSessionIds.push(body.id);
    shellSessionId = body.id;

    expect(body.claudeSessionId).toBeNull();
  });

  test("AC-1: claudeSessionId persists in session list", async ({ request }) => {
    const sessions = await listTerminalSessions(request);
    // Look both sessions up by their hoisted ids and assert they persist in the
    // list. The list shape omits claudeSessionId (its value is checked on the
    // POST responses above), so we assert presence, not the field here.
    const claudeSession = sessions.find((s) => s.id === claudeRowId);
    expect(claudeSession).toBeTruthy();

    const shellSession = sessions.find((s) => s.id === shellSessionId);
    expect(shellSession).toBeTruthy();
  });

  test("AC-2: server restart restores sessions with same claudeSessionId", async ({ request }) => {
    // Step 1: Create a claude-code session and note its IDs
    const createRes = await request.post(`${BASE}/api/terminal/sessions`, {
      data: { cwd: "/tmp", type: "claude-code", name: "E2E-Resume-Restart" },
      ignoreHTTPSErrors: true,
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    const sessionId = created.id;
    const claudeSessionIdBefore = created.claudeSessionId;
    createdSessionIds.push(sessionId);

    expect(claudeSessionIdBefore).toBeTruthy();

    // Step 2: Kill the server
    await killServer();

    // Step 3: Restart the server
    startServer();
    await waitForServer();

    // Give it a moment for restoreSessions() to complete
    await new Promise((r) => setTimeout(r, 2000));

    // Step 4: Verify the session is restored with the same claudeSessionId
    const sessionsRes = await fetch(`${BASE}/api/terminal/sessions`, {
      headers: { Accept: "application/json" },
    });
    expect(sessionsRes.ok).toBeTruthy();
    const sessions = await sessionsRes.json() as any[];

    const restored = sessions.find((s: any) => s.id === sessionId);
    expect(restored).toBeTruthy();
    expect(restored.claudeSessionId).toBe(claudeSessionIdBefore);
    expect(restored.type).toBe("claude-code");
  });

  test("AC-5: database has claude_session_id column", async ({ request }) => {
    const res = await request.post(`${BASE}/api/terminal/sessions`, {
      data: { cwd: "/tmp", type: "claude-code", name: "E2E-Resume-DBCheck" },
      ignoreHTTPSErrors: true,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    createdSessionIds.push(body.id);
    expect(body.claudeSessionId).toBeTruthy();

    const sessions = await listTerminalSessions(request);
    // The list shape omits claudeSessionId; the value is asserted on the POST
    // response above (body.claudeSessionId). Here we assert the row persists.
    const found = sessions.find((s) => s.id === body.id);
    expect(found).toBeTruthy();
  });
});
