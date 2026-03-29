/**
 * Playwright global teardown — runs AFTER all test suites.
 * Kills the isolated test server process started by global-setup.
 * Also cleans up any stale processes on the test port.
 */

import { execSync } from "child_process";

const TEST_PORT = 3334;

async function globalTeardown() {
  const pid = process.env.__TEST_SERVER_PID;

  if (pid) {
    console.log(`[global-teardown] Killing test server (PID: ${pid})...`);
    try {
      // Kill the process group (negative PID kills the group)
      process.kill(-Number(pid), "SIGTERM");
    } catch {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // Already dead
      }
    }
  }

  // Also kill any stale processes on the test port
  try {
    const pids = execSync(
      `lsof -ti :${TEST_PORT} 2>/dev/null || true`
    )
      .toString()
      .trim();
    if (pids) {
      execSync(`kill -9 ${pids.split("\n").join(" ")} 2>/dev/null || true`);
      console.log(`[global-teardown] Killed stale processes on port ${TEST_PORT}: ${pids.replace(/\n/g, ", ")}`);
    }
  } catch {
    // No stale processes
  }

  // Re-enable the openclaw-gateway LaunchAgent (if it was stopped by global-setup)
  try {
    const plistPath = `${process.env.HOME}/Library/LaunchAgents/ai.openclaw.gateway.plist`;
    execSync(
      `launchctl load ${plistPath} 2>/dev/null || true`
    );
    console.log("[global-teardown] Re-enabled openclaw-gateway LaunchAgent");
  } catch {}

  console.log("[global-teardown] Test server stopped.");
}

export default globalTeardown;
