/**
 * Playwright global teardown — runs AFTER all test suites.
 * Kills the isolated test server process started by global-setup.
 * Also cleans up any stale processes on the test port.
 */

import { execSync, execFileSync } from "child_process";

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

  // Kill ALL orphaned Chromium processes from Playwright test runs
  // These use a specific user-data-dir that identifies them as Playwright-spawned
  try {
    const chromiumPids = execSync(
      'ps aux | grep -E "chromium|Chromium" | grep "ms-playwright\|mcp-chrome" | grep -v grep | awk \'{ print $2 }\' 2>/dev/null || true'
    ).toString().trim();
    if (chromiumPids) {
      execSync(`kill -9 ${chromiumPids.split('\n').join(' ')} 2>/dev/null || true`);
      console.log(`[global-teardown] Killed ${chromiumPids.split('\n').length} orphaned Chromium processes`);
    } else {
      console.log("[global-teardown] No orphaned Chromium processes found.");
    }
  } catch {}

  // Auto-run AI visual review on screenshots
  try {
    const reviewScript = `${process.cwd()}/scripts/ai-review-screenshots.sh`;
    const fs = await import('fs');
    if (fs.existsSync(reviewScript)) {
      console.log("[global-teardown] Running AI visual review...");
      const pyScript = reviewScript.replace('ai-review-screenshots.sh', 'ai-review-screenshots.py');
      if (fs.existsSync(pyScript)) {
        execFileSync('python3', [pyScript], { stdio: 'inherit', timeout: 120000 });
      } else {
        // zsh, matching the script's shebang: it uses `typeset -A` + zsh array
        // syntax, which macOS' stock /bin/bash 3.2 rejects outright.
        execFileSync('zsh', [reviewScript], { stdio: 'inherit', timeout: 120000 });
      }
    }
  } catch (e) {
    console.log(`[global-teardown] AI review skipped: ${e instanceof Error ? e.message : e}`);
  }
}

export default globalTeardown;
