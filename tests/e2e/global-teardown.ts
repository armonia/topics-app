/**
 * Playwright global teardown — runs AFTER all test suites.
 * Kills the isolated test server process started by global-setup.
 * Also cleans up any stale processes on the test port.
 */

import { execSync } from "child_process";

const TEST_PORT = 13334;

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
      execSync(`kill ${pids.split("\n").join(" ")} 2>/dev/null || true`);
      console.log(`[global-teardown] Killed stale processes on port ${TEST_PORT}: ${pids.replace(/\n/g, ", ")}`);
    }
  } catch {
    // No stale processes
  }

  console.log("[global-teardown] Test server stopped.");

  // Auto-run AI visual review on screenshots
  try {
    const reviewScript = `${process.cwd()}/scripts/ai-review-screenshots.sh`;
    const fs = await import('fs');
    if (fs.existsSync(reviewScript)) {
      console.log("[global-teardown] Running AI visual review...");
      execSync(`bash ${reviewScript}`, { stdio: 'inherit', timeout: 120000 });
    }
  } catch (e) {
    console.log(`[global-teardown] AI review skipped: ${e instanceof Error ? e.message : e}`);
  }
}

export default globalTeardown;
