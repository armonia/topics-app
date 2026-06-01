import { expect, test } from "@playwright/test";
import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalSessions,
} from "./helpers/api-fixtures";
import { spawn, execSync } from "child_process";
import { resolve } from "path";
import net from "net";

const BASE = "http://localhost:13334";
const TEST_PORT = 13334;

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

/** Start the test server (same env as global-setup).
 *  TOPICS_PTY_SOCKET is REQUIRED here: without it the restarted server derives
 *  its bridge socket from cwd = the PRODUCTION bridge, and its reconcile kills
 *  the dev server's live Claude PTYs (knocking real sessions dormant). The
 *  start-test-server.sh script now also defaults this, but we set it explicitly
 *  so the isolation is visible at the call site and independent of the script. */
function startServer(): void {
  const scriptPath = resolve(__dirname, "../../scripts/start-test-server.sh");
  const proc = spawn("bash", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      BUN_PORT: String(TEST_PORT),
      DATA_DIR: "/tmp/topics-test-data",
      NO_TLS: "1",
      TOPICS_PTY_SOCKET: "/tmp/topics-pty-bridge-e2e-test.sock",
      GATEWAY_TOKEN: process.env.GATEWAY_TOKEN || "test-token",
      GATEWAY_URL: process.env.GATEWAY_URL || "http://127.0.0.1:18789",
    },
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

    expect(body.claudeSessionId).toBeNull();
  });

  test("AC-1: claudeSessionId persists in session list", async ({ request }) => {
    const sessions = await listTerminalSessions(request);
    const claudeSession = sessions.find((s: any) => s.name === "E2E-Resume-Claude");
    expect(claudeSession).toBeTruthy();
    expect(claudeSession.claudeSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const shellSession = sessions.find((s: any) => s.name === "E2E-Resume-Shell");
    expect(shellSession).toBeTruthy();
    expect(shellSession.claudeSessionId).toBeNull();
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
    const found = sessions.find((s: any) => s.id === body.id);
    expect(found).toBeTruthy();
    expect(found.claudeSessionId).toBe(body.claudeSessionId);
  });
});
