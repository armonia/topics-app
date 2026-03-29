/**
 * Playwright global setup — runs BEFORE all test suites.
 *
 * 1. Starts an isolated test server on port 3334 with its own SQLite DB
 * 2. Cleans up stale E2E test data from previous failed runs
 *
 * The test server uses /tmp/topics-test-data/ for its database,
 * completely isolated from the production data/ directory.
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

const BASE = "https://localhost:3334";
const TEST_SERVER_PORT = 3334;

let serverProcess: ChildProcess | null = null;

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/topics`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok || res.status === 401 || res.status === 403) {
        // Server is up (even if auth fails, it's responding)
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Test server did not start within ${timeoutMs}ms`);
}

async function startTestServer(): Promise<void> {
  const scriptPath = resolve(__dirname, "../../scripts/start-test-server.sh");

  serverProcess = spawn("bash", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      BUN_PORT: String(TEST_SERVER_PORT),
      DATA_DIR: "/tmp/topics-test-data",
      GATEWAY_TOKEN: process.env.GATEWAY_TOKEN || "test-token",
      GATEWAY_URL: process.env.GATEWAY_URL || "http://127.0.0.1:18789",
    },
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[test-server] ${msg}`);
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[test-server:err] ${msg}`);
  });

  serverProcess.on("error", (err) => {
    console.error("[test-server] Failed to start:", err.message);
  });

  // Store PID for teardown
  if (serverProcess.pid) {
    process.env.__TEST_SERVER_PID = String(serverProcess.pid);
  }

  console.log(
    `[global-setup] Starting test server on port ${TEST_SERVER_PORT} (PID: ${serverProcess.pid})...`
  );

  await waitForServer(BASE);
  console.log("[global-setup] Test server is ready.");
}

async function globalSetup() {
  // Disable TLS verification for localhost self-signed certs
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  // Start isolated test server
  await startTestServer();

  try {
    // Clean up stale E2E topics
    const topicsRes = await fetch(`${BASE}/api/topics`, {
      headers: { Accept: "application/json" },
    });
    if (topicsRes.ok) {
      const data = (await topicsRes.json()) as {
        topics: Record<string, { id: string; name: string }>;
      };
      const staleTopics = Object.values(data.topics).filter(
        (t) => t.name && t.name.startsWith("E2E-")
      );
      if (staleTopics.length > 0) {
        console.log(
          `[global-setup] Cleaning ${staleTopics.length} stale E2E topics...`
        );
        for (const topic of staleTopics) {
          await fetch(`${BASE}/api/topics/${topic.id}`, {
            method: "DELETE",
          }).catch(() => {});
        }
      }
    }

    // Clean up stale E2E tasks — the /api/boards/tasks endpoint returns
    // an object with project keys, each containing an array of tasks
    const boardsRes = await fetch(`${BASE}/api/boards/tasks`, {
      headers: { Accept: "application/json" },
    });
    if (boardsRes.ok) {
      const data = await boardsRes.json();
      // Handle both array and object response formats
      const tasks: Array<{ id: string; text: string; projectPath?: string }> =
        Array.isArray(data)
          ? data
          : (Object.values(data).flat() as any);
      const staleTasks = (tasks || []).filter(
        (t: any) =>
          t &&
          t.text &&
          (t.text.startsWith("KB-") || t.text.startsWith("E2E-"))
      );
      if (staleTasks.length > 0) {
        console.log(
          `[global-setup] Cleaning ${staleTasks.length} stale E2E tasks...`
        );
        for (const task of staleTasks) {
          const projectId = encodeURIComponent(
            (task as any).projectPath || ""
          );
          await fetch(`${BASE}/api/boards/${projectId}/tasks/${task.id}`, {
            method: "DELETE",
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    // Server might have issues — don't fail setup, tests will catch errors
    console.warn(
      "[global-setup] Could not clean stale data:",
      (err as Error).message
    );
  }
}

export default globalSetup;
