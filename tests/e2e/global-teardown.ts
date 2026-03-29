/**
 * Playwright global teardown — runs AFTER all test suites.
 * Kills the isolated test server process started by global-setup.
 */

async function globalTeardown() {
  const pid = process.env.__TEST_SERVER_PID;

  if (pid) {
    console.log(`[global-teardown] Killing test server (PID: ${pid})...`);
    try {
      // Kill the process group (negative PID kills the group)
      process.kill(-Number(pid), "SIGTERM");
    } catch {
      try {
        // Fallback: kill just the process
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // Already dead
      }
    }
    console.log("[global-teardown] Test server stopped.");
  } else {
    console.log("[global-teardown] No test server PID found — nothing to stop.");
  }
}

export default globalTeardown;
