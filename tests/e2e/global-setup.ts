/**
 * Playwright global setup — runs BEFORE all test suites.
 *
 * 1. Starts an isolated test server on port 13334 with its own SQLite DB
 * 2. Cleans up stale E2E test data from previous failed runs
 *
 * The test server uses /tmp/topics-test-data/ for its database,
 * completely isolated from the production data/ directory.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// Test server runs WITHOUT TLS for simplicity (NO_TLS=1)
// Port 13334 chosen to avoid conflicts with production services
// (port 3334 is used by the openclaw-gateway voice-call webhook)
const BASE = "http://localhost:13334";
const TEST_SERVER_PORT = 13334;

/**
 * Resolve a Chromium executable on disk. Falls back through the most likely
 * Playwright cache locations because the server's `playwright-core` may pin
 * a slightly older manifest version than the binary that `@playwright/test`
 * actually installs (e.g. server resolves chromium-1208 but the cache holds
 * chromium-1217). Returns "" if nothing found — BrowserService will then
 * surface a clear error at first use.
 */
function resolveChromiumPath(): string {
  const cacheDir = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cacheDir)) return "";
  try {
    const entries = readdirSync(cacheDir).filter((d) => d.startsWith("chromium-"));
    // Prefer the highest revision numerically (newer cache wins).
    entries.sort((a, b) => {
      const ax = parseInt(a.split("-")[1] || "0", 10);
      const bx = parseInt(b.split("-")[1] || "0", 10);
      return bx - ax;
    });
    for (const dir of entries) {
      const candidate = join(
        cacheDir,
        dir,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return "";
}

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
      // Phase 30 plan 30-05: dedicated TOPICS_HOME so the test server's
      // daemon lock + state files don't collide with the dev server
      // (which holds ~/.topics/daemon-process.lock).
      TOPICS_HOME: "/tmp/topics-test-data/.topics-home",
      // Dedicated PTY-bridge socket. The bridge socket is otherwise derived
      // from cwd, which the test server SHARES with the dev server — so the
      // test server's reconcile would see the dev server's live Claude PTYs
      // as "orphans" (absent from its test DB) and KILL them. An isolated
      // socket gives the test run its own empty bridge. (Honored by
      // getSocketPath() in server/routes/terminal.ts.)
      TOPICS_PTY_SOCKET: "/tmp/topics-pty-bridge-e2e-test.sock",
      // Never let the test server install the Topics->Claude hooks into the
      // developer's real global ~/.claude/settings.json (see
      // server/lib/claude-hooks-install.ts). The TOPICS_PTY_SOCKET marker above
      // already triggers the skip; this is the explicit, self-documenting opt-out.
      TOPICS_NO_HOOK_INSTALL: "1",
      // Phase 30 plan 30-05: server's playwright-core ships an older
      // chromium-1208 manifest, but @playwright/test installs the current
      // chromium-1217 binary. Pin the BrowserService Chromium to the
      // actually-installed binary. Override via CHROMIUM_PATH env if
      // running on a machine with a different layout.
      CHROMIUM_PATH: process.env.CHROMIUM_PATH ||
        resolveChromiumPath(),
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

  // Phase 30.1 polish — propagate DATA_DIR to the Playwright runner so specs
  // that need to read files written by the test server (e.g.
  // browser-persistence.spec.ts reading data/browser-state/<id>/storage.json)
  // can resolve the same path the server uses. The spawned test server
  // already gets DATA_DIR via startTestServer(); without this line the
  // runner's process.env.DATA_DIR stays unset and specs would have to
  // hardcode the path.
  if (!process.env.DATA_DIR) process.env.DATA_DIR = "/tmp/topics-test-data";

  // Kill any stale test server processes on the test port before starting
  try {
    const stalePids = execSync(
      `lsof -ti :${TEST_SERVER_PORT} 2>/dev/null || true`
    ).toString().trim();
    if (stalePids) {
      execSync(`kill ${stalePids.split("\n").join(" ")} 2>/dev/null || true`);
      console.log(`[global-setup] Killed stale test processes on port ${TEST_SERVER_PORT}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {}

  // Phase 30.1 polish — wipe per-topic browser-state from previous runs.
  // BASE_DIR in browser-state-store.ts now honours DATA_DIR, but pre-fix
  // runs (or runs with the old default) may have left files under
  // <repo>/data/browser-state/. Belt-and-braces: clean both locations
  // before the test server boots so restoreAllContexts doesn't re-hydrate
  // a context with stale cookies that would skew BROWSER-CHAT-01 asserts.
  const { rmSync } = await import("fs");
  for (const dir of ["/tmp/topics-test-data/browser-state", join(process.cwd(), "data", "browser-state")]) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        console.log(`[global-setup] Wiped stale browser-state: ${dir}`);
      }
    } catch (err) {
      console.warn(`[global-setup] Failed to wipe ${dir}: ${(err as Error).message}`);
    }
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
      const E2E_TOPIC_PATTERNS = [
        /^E2E-/,
        /^Toolbar E2E /,
        /^Pin E2E /,
        /^Chat E2E Test /,
        /^Input Feature Test /,
        /^Branch E2E /,
      ];
      const staleTopics = Object.values(data.topics).filter(
        (t) => t.name && E2E_TOPIC_PATTERNS.some((p) => p.test(t.name))
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

    // Reset UI state to prevent stale panels/layout from breaking tests.
    // Includes both legacy keys AND the Phase 30 pane-store-v2 reducer snapshot
    // so the unified-timeline sidebar starts clean.
    const uiResets: Record<string, any> = {
      panels: { openPanels: [] },
      "grid-layout": { gridRows: [], gridRowHeights: [], soloTopicIds: [] },
      "panel-order": { order: [], pinned: [] },
      "pane-store-v2": {
        panes: {},
        groups: { "group:default": { id: "group:default", paneIds: [], splitRatio: 1, splitAxis: "horizontal" } },
        projects: {},
        groupOrder: ["group:default"],
        closedStack: [],
        lastSeq: 0,
      },
    };
    for (const [key, value] of Object.entries(uiResets)) {
      await fetch(`${BASE}/api/ui-state/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      }).catch(() => {});
    }
    console.log("[global-setup] Reset UI state (panels, grid-layout, panel-order)");
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

    // Seed messages into "Web Search Test" so tests that depend on it having
    // messages (e.g., scroll position, markdown rendering) work reliably
    const topicsAfterSeed = await fetch(`${BASE}/api/topics`, {
      headers: { Accept: "application/json" },
    });
    if (topicsAfterSeed.ok) {
      const afterData = (await topicsAfterSeed.json()) as {
        topics: Record<string, { id: string; name: string }>;
      };
      const webSearchTopic = Object.values(afterData.topics).find(
        (t) => t.name === "Web Search Test"
      );
      if (webSearchTopic) {
        // Check if it already has messages via history endpoint
        const historyRes = await fetch(
          `${BASE}/api/history/${webSearchTopic.id}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }
        );
        const historyData = historyRes.ok ? await historyRes.json() as { messages?: any[] } : { messages: [] };
        if (!historyData.messages || historyData.messages.length === 0) {
          // Seed sample messages for tests that expect content
          const sampleMessages = [
            "Here is a **bold** statement and some `inline code`.\n\n```javascript\nconst x = 42;\nconsole.log(x);\n```\n\n- Item one\n- Item two\n\n[A link](https://example.com)",
            "This is a follow-up response with more content.\n\n## Heading\n\nSome paragraph text with *italics* and **bold**.",
            "Final message with a longer response to ensure scrollable content is present for scroll position tests.",
          ];
          for (const content of sampleMessages) {
            await fetch(`${BASE}/api/topics/${webSearchTopic.id}/system-message`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content }),
            }).catch(() => {});
          }
          console.log(`[global-setup] Seeded ${sampleMessages.length} messages into "Web Search Test"`);
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

// Cleanup on crash/interrupt — kill test server + Chromium processes
function emergencyCleanup() {
  try {
    if (serverProcess?.pid) process.kill(-serverProcess.pid, 'SIGTERM');
  } catch {}
  try {
    execSync(`lsof -ti :${TEST_SERVER_PORT} 2>/dev/null | xargs kill 2>/dev/null || true`);
    execSync('ps aux | grep -E "chromium|Chromium" | grep "ms-playwright" | grep -v grep | awk \'{ print $2 }\' | xargs kill -9 2>/dev/null || true');
  } catch {}
}
process.on('SIGINT', emergencyCleanup);
process.on('SIGTERM', emergencyCleanup);
process.on('exit', emergencyCleanup);

export default globalSetup;
