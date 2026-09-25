#!/usr/bin/env bun
/**
 * AI-BRIDGE DAEMONS A TEST RUN LEFT ALIVE.
 *
 * WHY. A test that starts a real daemon and forgets it leaves a detached `bun`
 * behind: nothing reconnects to a socket in a deleted temp dir, so it lives
 * until its own orphan monitor retires it, and on 25/09 some of them had not
 * been retired after twelve hours. Verifiers found seven per round of one card's
 * tests, and nine from a single e2e round, on a Mac already at load 25-50.
 * Nobody saw them because every run was green.
 *
 * HOW A DAEMON IS TIED TO A RUN. By an environment variable, not by a time
 * window or a path. The suite runners write `TOPICS_TEST_RUN_ID` before
 * starting `bun test` or the e2e server, and a daemon inherits it: the client
 * spawns it with `{ ...process.env }`. Time and path would both lie on this
 * machine. Other agents run the same suite from other worktrees at the same
 * time, and a run from the main checkout shares its script path with the
 * PRODUCTION daemon. Production never carries the marker, so this can neither
 * count it nor touch it.
 *
 * CLI: `bun scripts/stray-ai-bridges.ts --run-id <id>` lists the run's daemons
 * that are still alive, ends them, and exits 1. Exit 0 when there are none.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

export const TEST_RUN_ENV = "TOPICS_TEST_RUN_ID";

/** Hex only: it is matched as a whole token inside a space-separated env dump. */
export function newTestRunId(): string {
  return randomBytes(8).toString("hex");
}

export interface StrayDaemon {
  pid: number;
  socket: string | null;
}

// The two launch shapes of `aiBridgeDaemonLaunch()`: the script in a checkout,
// the flag on the compiled binary. Both are followed by `--socket`.
const DAEMON_ARGV = /(?:ai-bridge\.mjs|--ai-bridge-daemon) --socket (\S+)/;

function daemonsOnDarwin(runId: string): StrayDaemon[] {
  // `-E` appends each process's environment to its command line. It reads our
  // own processes only, which is all a test run can have started.
  let out = "";
  try {
    out = execFileSync("ps", ["-E", "-ww", "-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return [];
  }
  const marker = ` ${TEST_RUN_ENV}=${runId}`;
  const found: StrayDaemon[] = [];
  for (const line of out.split("\n")) {
    const argv = DAEMON_ARGV.exec(line);
    if (!argv) continue;
    const at = line.indexOf(marker);
    if (at < 0) continue;
    const next = line.charAt(at + marker.length);
    if (next !== "" && next !== " ") continue;
    found.push({ pid: Number(line.trim().split(/\s+/)[0]), socket: argv[1] });
  }
  return found;
}

function daemonsOnLinux(runId: string): StrayDaemon[] {
  const found: StrayDaemon[] = [];
  const marker = `${TEST_RUN_ENV}=${runId}`;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = DAEMON_ARGV.exec(readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").join(" "));
      if (!argv) continue;
      if (!readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(marker)) continue;
      found.push({ pid: Number(name), socket: argv[1] });
    } catch { /* gone between readdir and read, or not ours */ }
  }
  return found;
}

/** The daemons alive right now that were born inside this run. */
export function aiBridgesOfRun(runId: string): StrayDaemon[] {
  if (!runId) return [];
  if (process.platform === "darwin") return daemonsOnDarwin(runId);
  if (process.platform === "linux") return daemonsOnLinux(runId);
  // Windows starts no ai-bridge by default (`aiBridgeEnabled()`).
  return [];
}

/**
 * Who is still alive once the run is over. A teardown's SIGTERM may still be in
 * flight when the runner gets here, so a daemon counts only if it outlives
 * `settleMs`.
 */
export async function strayAiBridges(runId: string, { settleMs = 5_000 } = {}): Promise<StrayDaemon[]> {
  const deadline = Date.now() + settleMs;
  let alive = aiBridgesOfRun(runId);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    alive = aiBridgesOfRun(runId);
  }
  return alive;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * The daemons a process's own client spawned: the client passes its pid as
 * `--parent-pid`. Asked while that process is alive, so the pid cannot have been
 * reused by anyone else.
 */
function aiBridgesSpawnedBy(parentPid: number): number[] {
  if (process.platform === "win32") return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const parent = new RegExp(`--parent-pid ${parentPid}(?:\\s|$)`);
  return out.split("\n").filter((l) => DAEMON_ARGV.test(l) && parent.test(l)).map((l) => Number(l.trim().split(/\s+/)[0]));
}

/** SIGTERM, so each daemon takes its CLIs down with it; SIGKILL for one still there after `graceMs`. */
async function endAiBridges(pids: number[], graceMs = 3_000): Promise<void> {
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  const deadline = Date.now() + graceMs;
  while (pids.some(isAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids) { if (isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } }
}

/**
 * Stops the real ai-bridge daemons THIS test process started.
 *
 * The daemon is detached on purpose: in production it outlives a server
 * restart and keeps the CLIs alive. In a test the same design leaves it behind,
 * on a socket in a temp dir nobody reconnects to, watching a parent that is the
 * whole `bun test` process. A file that drives the real client calls this from
 * its `afterAll`, which bun runs after a failed or timed-out test too, and the
 * preload calls it once more at the end of the run.
 */
export async function stopOwnAiBridges(): Promise<void> {
  const pids = aiBridgesSpawnedBy(process.pid);
  if (pids.length === 0) return;
  // The client first. Left connected, it takes the daemon's death for a crash
  // and spawns a new one.
  const { __resetAiBridgeClientForTests } = await import("../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  await endAiBridges(pids);
}

/**
 * Lists the strays, then ends them: they are this run's own processes, proven
 * by the marker, and every minute they stay costs the machine. The run stays red
 * either way. SIGTERM first so the daemon takes its CLIs down with it.
 */
export async function reportAndEndStrays(strays: StrayDaemon[], log: (line: string) => void = console.error): Promise<void> {
  if (strays.length === 0) return;
  log(`stray-ai-bridges: ${strays.length} ai-bridge daemon(s) started by this run are still alive:`);
  for (const s of strays) log(`  pid ${s.pid}  socket ${s.socket ?? "?"}`);
  log("stray-ai-bridges: a test that starts a daemon has to stop it (stopOwnAiBridges in scripts/stray-ai-bridges.ts). Ending them now.");
  await endAiBridges(strays.map((s) => s.pid));
}

// Not `import.meta.main` and no top-level await: the e2e teardown imports this
// module, and Playwright loads it as CommonJS.
if (/stray-ai-bridges\.ts$/.test(process.argv[1] ?? "")) {
  void (async () => {
    const i = process.argv.indexOf("--run-id");
    const runId = i >= 0 ? process.argv[i + 1] ?? "" : process.env[TEST_RUN_ENV] ?? "";
    if (!runId) {
      console.error(`stray-ai-bridges: no run id (pass --run-id or set ${TEST_RUN_ENV})`);
      process.exit(2);
    }
    const strays = await strayAiBridges(runId);
    await reportAndEndStrays(strays);
    process.exit(strays.length > 0 ? 1 : 0);
  })();
}
