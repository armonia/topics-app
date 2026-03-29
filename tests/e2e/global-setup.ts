/**
 * Playwright global setup — runs BEFORE all test suites.
 *
 * 1. Starts an isolated test server on port 3334 with its own SQLite DB
 * 2. Cleans up stale E2E test data from previous failed runs
 *
 * The test server uses /tmp/topics-test-data/ for its database,
 * completely isolated from the production data/ directory.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { resolve } from "path";

// Test server runs WITHOUT TLS for simplicity (NO_TLS=1)
const BASE = "http://localhost:3334";
const TEST_SERVER_PORT = 3334;

let serverProcess: ChildProcess | null = null;

async function waitForServer(_url: string, timeoutMs = 30000): Promise<void> {
  const net = await import("net");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const isOpen = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(
        { port: TEST_SERVER_PORT, host: "127.0.0.1" },
        () => { socket.destroy(); resolve(true); }
      );
      socket.on("error", () => resolve(false));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    if (isOpen) return;
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
      NO_TLS: "1",
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

  // Stop the openclaw-gateway LaunchAgent if it's running — it binds to port 3334
  // as a reverse proxy and has KeepAlive=true, so killing it alone causes macOS to restart it.
  // We unload it, wait for it to die, then kill any remaining processes on the port.
  try {
    const plistPath = `${process.env.HOME}/Library/LaunchAgents/ai.openclaw.gateway.plist`;
    execSync(`launchctl unload ${plistPath} 2>/dev/null || true`);
    console.log(`[global-setup] Unloaded openclaw-gateway LaunchAgent`);
    await new Promise((r) => setTimeout(r, 2000)); // Wait for gateway to fully stop
  } catch {}

  // Kill any stale processes on the test port before starting
  // Retry to handle race conditions with LaunchAgent restarts
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const stalePids = execSync(
        `lsof -ti :${TEST_SERVER_PORT} 2>/dev/null || true`
      ).toString().trim();
      if (stalePids) {
        execSync(`kill -9 ${stalePids.split("\n").join(" ")} 2>/dev/null || true`);
        console.log(`[global-setup] Killed stale processes on port ${TEST_SERVER_PORT} (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        break;
      }
    } catch {}
  }

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

  // Seed baseline data that legacy tests (Phase 1-2) expect
  await seedBaselineData();
}

/**
 * Create baseline topics that older tests reference by name.
 * Phase 3-12 tests self-provision via API fixtures; these are for Phase 1-2 tests.
 */
async function seedBaselineData() {
  const requiredTopics = [
    { name: "Web Search Test", type: "chat" },
    { name: "Best Ramen", type: "chat" },
  ];

  try {
    const topicsRes = await fetch(`${BASE}/api/topics`, {
      headers: { Accept: "application/json" },
    });
    if (!topicsRes.ok) return;

    const data = (await topicsRes.json()) as {
      topics: Record<string, { id: string; name: string }>;
    };
    const existingNames = new Set(
      Object.values(data.topics).map((t) => t.name)
    );

    for (const topic of requiredTopics) {
      if (!existingNames.has(topic.name)) {
        const res = await fetch(`${BASE}/api/topics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: topic.name, type: topic.type }),
        });
        if (res.ok) {
          console.log(`[global-setup] Seeded topic: "${topic.name}"`);
        }
      }
    }
  } catch (err) {
    console.warn(
      "[global-setup] Could not seed baseline data:",
      (err as Error).message
    );
  }
}

export default globalSetup;
