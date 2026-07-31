/**
 * Playwright global teardown — runs AFTER all test suites.
 * Kills the isolated test server process started by global-setup.
 * Also cleans up any stale processes on the test port.
 */

import { execSync, execFileSync } from "child_process";
import { E2E_PORT, descendantsOf } from "./helpers/test-server";
import { releaseRunLock } from "./helpers/run-lock";

const TEST_PORT = E2E_PORT;

async function globalTeardown() {
  // Da qui in poi la morte del server è ATTESA: il banner "morto a metà run"
  // di global-setup (stesso processo, modulo diverso) deve tacere.
  process.env.__E2E_TEARDOWN_STARTED = "1";
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

  // Also kill any stale processes on the test port.
  // `-sTCP:LISTEN`: solo chi ASCOLTA. Senza il filtro lsof restituisce anche i
  // socket dei client — i Chromium ancora connessi mentre si smonta — e questo
  // kill li porterebbe via insieme al server.
  try {
    const pids = execSync(
      `lsof -ti :${TEST_PORT} -sTCP:LISTEN 2>/dev/null || true`
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

  // Reap Chromiums orphaned by THIS run — never anyone else's.
  //
  // This used to kill every ms-playwright/mcp-chrome Chromium on the machine, on
  // every single run (not just crashes). That reaches well outside the project:
  // a concurrent E2E run in another repo lost its browsers and its results, and
  // `mcp-chrome` is the user's own claude-in-chrome window. global-setup snapshots
  // the PIDs alive before we launch anything and hands them over in
  // __FOREIGN_CHROMIUM_PIDS; whatever was already running is by definition not
  // ours, so it is spared. Everything else is still reaped hard.
  try {
    const spared = new Set(
      (process.env.__FOREIGN_CHROMIUM_PIDS || "").split(",").filter(Boolean),
    );
    // Nostri = discendenti di QUESTO runner. La fotografia dei PID pre-esistenti
    // resta come cintura in più, ma da sola non basterebbe più: con gli shard in
    // parallelo i browser degli altri nascono DOPO la nostra fotografia.
    const mine = descendantsOf(process.pid);
    const chromiumPids = execSync(
      'ps ax -o pid=,command= | grep -E "ms-playwright|mcp-chrome" | grep -Ei "chromium|chrome" | grep -v grep | awk \'{ print $1 }\' 2>/dev/null || true'
    ).toString().trim();
    const ours = chromiumPids
      .split("\n")
      .map((s: string) => s.trim())
      .filter((pid: string) => /^\d+$/.test(pid) && !spared.has(pid) && mine.has(pid));
    if (ours.length) {
      execSync(`kill -9 ${ours.join(' ')} 2>/dev/null || true`);
      console.log(`[global-teardown] Killed ${ours.length} orphaned Chromium process(es) from this run` +
        (spared.size ? `; spared ${spared.size} pre-existing` : ""));
    } else {
      console.log("[global-teardown] No orphaned Chromium processes found." +
        (spared.size ? ` (${spared.size} pre-existing spared)` : ""));
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

  // Ultimo passo: restituisce la porta. Va DOPO il kill del server — finché
  // quel processo respira, la prossima run non deve poter entrare e ammazzarlo.
  // `releaseRunLock` toglie solo il lock di questo PID, quindi è innocuo anche
  // se il lock nel frattempo è passato a qualcun altro.
  releaseRunLock(TEST_PORT);
}

export default globalTeardown;
