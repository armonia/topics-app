/**
 * A RUN CUT MID-TEST LEAVES NO SERVER AND NO SCRATCH FOLDER BEHIND.
 *
 * THE DEFECT (card 617a7a68). `primary-role-two-servers` boots the real server
 * as a child process and stops it from `afterAll`. A run that never reaches
 * `afterAll` left the server running with its test environment and its
 * listening socket: two of them were still up fifteen hours later, and
 * `/tmp/topics-test` had grown to hundreds of folders.
 *
 * WHAT THIS TEST DOES. It runs that file as a real child `bun test`, waits
 * until a server of its own is registered with the watchdog, cuts the runner
 * down, and then asserts from the OUTSIDE, on the pids the run registered:
 *   - no registered process group answers `kill(-pgid, 0)` within 10 s;
 *   - the scratch roots of the cut run are gone.
 *
 * WHY THE RUNNER IS KILLED, not asked to stop. Measured on bun 1.4.4: SIGINT
 * and SIGTERM sent to `bun test` while a test runs kill neither the runner nor
 * the test (they are swallowed), and `process.on("exit", ...)` fires for
 * neither. This test sends SIGINT first for exactly that reason, then SIGKILL,
 * which is what a CI cancel or a harness reaping its children ends up doing -
 * and which runs no code in the dying process at all. The signal goes to the
 * runner's PID only, never to its group: the servers sit in groups of their
 * own, so nothing here touches them. Only the watchdog can.
 *
 * THE MUTATION THAT MUST TURN IT RED: drop `detached: true` from the server
 * spawn in `bootOnce`. The server then shares the runner's group, leads no
 * group of its own, the watchdog's `kill(-pid)` fails, and the server survives
 * the ten seconds.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./helpers";
import { slackMs } from "../helpers/time-slack";
import { readOrphanGuardRegistry } from "../helpers/orphan-guard";

/** The test of the two-server file that boots one server and nothing else. */
const CHILD_TEST_NAME = "a virgin server claims a todo card";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True while a process group with this id still holds at least one process. */
function groupAlive(groupLeaderPid: number): boolean {
  try {
    process.kill(-groupLeaderPid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLogQuietly(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * The addresses something is LISTENING on for this port, read from the system
 * table: `ss` where there is one (Linux), `lsof` otherwise (macOS). An empty
 * list means the port is not open, which the test tells apart from a port open
 * on the wrong address.
 */
function listeningAddresses(port: number): string[] {
  for (const argv of [["ss", "-ltnH"], ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]]) {
    const run = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
    if (!run.success) continue;
    const found: string[] = [];
    for (const line of run.stdout.toString().split("\n")) {
      for (const field of line.trim().split(/\s+/)) {
        const match = /^(.+):(\d+)$/.exec(field);
        if (match && Number(match[2]) === port) found.push(match[1]);
      }
    }
    return found;
  }
  throw new Error("neither `ss` nor `lsof` is available: the listening table cannot be read");
}

/** Loopback in the shapes `ss` and `lsof` print. */
function isLoopback(address: string): boolean {
  return address.startsWith("127.") || address === "::1" || address === "[::1]";
}

let leftovers: { groups: number[]; roots: string[] } = { groups: [], roots: [] };

// This test exists to prove nothing is left behind, so it must not BE the thing
// that leaves something behind when it fails.
afterAll(() => {
  for (const group of leftovers.groups) {
    try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ }
  }
  for (const root of leftovers.roots) {
    if (root.startsWith("/tmp/topics-test/")) rmSync(root, { recursive: true, force: true });
  }
});

test("a cut run leaves no server process group and no scratch folder", async () => {
  const runner = Bun.spawn(["bun", "test", "tests/integration/primary-role-two-servers.test.ts", "-t", CHILD_TEST_NAME], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // Its own group, so the signal below can be aimed at the runner's pid while
    // leaving every other group of this machine alone.
    detached: true,
  });

  // The run has started a server once it has registered one with the watchdog.
  const bootDeadline = Date.now() + slackMs(120_000);
  let registry = readOrphanGuardRegistry(runner.pid);
  while (Date.now() < bootDeadline && (registry === null || registry.groups.length === 0)) {
    if (runner.exitCode !== null) break;
    await Bun.sleep(200);
    registry = readOrphanGuardRegistry(runner.pid);
  }
  expect(registry?.groups ?? []).not.toHaveLength(0);
  const { groups, roots } = registry as { groups: number[]; roots: string[] };
  leftovers = { groups, roots };
  expect(roots.every((root) => root.startsWith("/tmp/topics-test/"))).toBe(true);
  expect(groups.every((group) => groupAlive(group))).toBe(true);

  // Not cut at the spawn, but once the server is really LISTENING: that is the
  // process the card found still up fifteen hours later. The run writes the
  // server's own output next to its data, port included.
  const listeningDeadline = Date.now() + slackMs(120_000);
  let port = 0;
  while (Date.now() < listeningDeadline && port === 0) {
    for (const root of roots) {
      const log = readLogQuietly(join(root, "server-1.log"));
      port = Number(/running at http:\/\/localhost:(\d+)/.exec(log)?.[1] ?? 0);
      if (port) break;
    }
    if (!port) await Bun.sleep(250);
  }
  expect(port).toBeGreaterThan(0);
  // The bar of the card: loopback only, never reachable from the LAN.
  const listeners = listeningAddresses(port);
  expect(listeners.length).toBeGreaterThan(0);
  expect(listeners.filter((address) => !isLoopback(address))).toEqual([]);

  // Cut the run down: SIGINT is what a person presses, SIGKILL is what is left
  // when the runner swallows it.
  process.kill(runner.pid, "SIGINT");
  const intDeadline = Date.now() + slackMs(3000);
  while (Date.now() < intDeadline && alive(runner.pid)) await Bun.sleep(100);
  if (alive(runner.pid)) process.kill(runner.pid, "SIGKILL");
  await runner.exited;

  // Ten seconds, the bar of the card: after them nothing of that run is around.
  const cleanupDeadline = Date.now() + slackMs(10_000);
  while (Date.now() < cleanupDeadline && groups.some((group) => groupAlive(group))) await Bun.sleep(200);
  const survivors = groups.filter((group) => groupAlive(group));
  expect(survivors).toEqual([]);

  const rootsDeadline = Date.now() + slackMs(10_000);
  while (Date.now() < rootsDeadline && roots.some((root) => existsSync(root))) await Bun.sleep(200);
  expect(roots.filter((root) => existsSync(root))).toEqual([]);
  leftovers = { groups: [], roots: [] };
}, slackMs(240_000));
