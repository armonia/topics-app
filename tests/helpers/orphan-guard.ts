/**
 * THE WATCHDOG THAT OUTLIVES THE TEST RUN.
 *
 * THE DEFECT (card 617a7a68). A test that boots the real server as a child
 * process stops it from `afterAll`. A run that is CUT - a CI cancel, a harness
 * that kills the runner, Ctrl-C - never reaches `afterAll`, and the server goes
 * on running with its test environment and its listening socket. Two of them
 * were still up fifteen hours later, holding ~100 MB each, and
 * `/tmp/topics-test` had grown to 387 directories.
 *
 * WHY AN IN-PROCESS HOOK CANNOT DO IT (measured here on bun 1.4.4):
 *   - SIGINT and SIGTERM sent to `bun test` while a test runs do NOT kill the
 *     runner at all, and no `process.on("exit")` handler fires.
 *   - what does end a cut run is a SIGKILL on the runner, and SIGKILL runs no
 *     code in the dying process by definition.
 * So the only cleanup that can be trusted is one that does not live in the test
 * process: a separate process, in its own session, that watches the runner and
 * acts once the runner is gone.
 *
 * THE CONTRACT. A server registered here must be `detached: true`, i.e. the
 * LEADER of its own process group: the guard signals `-pid`, which reaches
 * everything that server spawned itself (a tunnel helper, a worktree command)
 * with one signal, and which plainly fails for a process that leads no group.
 * That is deliberate - a non-detached server cannot be cleaned up without
 * leaving its grandchildren behind, so registering one has to break loudly
 * rather than half-work.
 *
 * This file is BOTH the library the tests import and the watchdog's entry
 * point: run as a script (`bun tests/helpers/orphan-guard.ts <registry>`) it
 * polls the registry instead of exporting anything, which keeps the watchdog's
 * code one import-free file next to what it protects.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the registries live: one JSON file per watched test process. Nested
 * under the base `testTmpDir` already hands out (not a sibling of it in bare
 * `/tmp`): the CI check that flags a test writing outside its private TMPDIR
 * allows exactly that base, named `TEST_TMP_BASE_NAME` in
 * `scripts/test-unit-shards.ts`, and nothing else at the top of real `/tmp`.
 * The watchdog removes this directory once it empties the last registry out
 * of it, so a run that registered nobody leaves no trace there either.
 */
export const ORPHAN_GUARD_DIR = "/tmp/topics-test/.guards";

/**
 * Only paths under this prefix are ever removed by the watchdog. `testTmpDir`
 * hands out `/tmp/topics-test/<label>-<random>`; a registry naming anything
 * else is ignored, so a corrupt or hand-edited file cannot turn the watchdog
 * into an `rm -rf` of somewhere that matters.
 */
const REMOVABLE_PREFIX = "/tmp/topics-test/";

/** How often the watchdog looks at the runner and at its registry. */
const POLL_MS = 250;

/**
 * The watchdog gives up after this long even if the runner is still alive, so
 * a crashed or wedged runner cannot leave a poller behind for days. Longer
 * than any test run of this repo (the unit suite is minutes, not hours).
 */
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

interface Registry {
  /** The test process being watched. */
  owner: number;
  /** Process group leaders to SIGKILL once the owner is gone. */
  groups: number[];
  /** Scratch roots to remove once the owner is gone. */
  roots: string[];
}

export function orphanGuardRegistryPath(ownerPid: number): string {
  return join(ORPHAN_GUARD_DIR, `${ownerPid}.json`);
}

/** Reads a registry, or null when it is missing or unreadable. */
export function readOrphanGuardRegistry(ownerPid: number): Registry | null {
  try {
    const parsed = JSON.parse(readFileSync(orphanGuardRegistryPath(ownerPid), "utf8")) as Registry;
    if (typeof parsed.owner !== "number" || !Array.isArray(parsed.groups) || !Array.isArray(parsed.roots)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── The library side: what a test calls ──────────────────────────────────────

let localState: Registry | null = null;
let watchdog: ReturnType<typeof Bun.spawn> | null = null;

/** Rewrites the registry atomically: the watchdog never reads a half file. */
function flush(): void {
  if (!localState) return;
  const target = orphanGuardRegistryPath(localState.owner);
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(ORPHAN_GUARD_DIR, { recursive: true });
  writeFileSync(temporary, JSON.stringify(localState));
  renameSync(temporary, target);
}

function ensureWatchdog(): void {
  // `localState` and `watchdog` are retired together (see `retireOrphanGuard`):
  // checking the watchdog alone would trust a handle left over from a server
  // this process already finished with, while `localState` is already null -
  // the short-circuit below would then skip recreating it and the caller's
  // `as Registry` cast would push onto `null`.
  if (watchdog && watchdog.exitCode === null && localState) return;
  localState ??= { owner: process.pid, groups: [], roots: [] };
  flush();
  // Its own session (`detached`), no stdio of the runner and unreferenced: it
  // has to survive both a SIGKILL on the runner and a signal sent to the
  // runner's whole process group, and it must not hold the runner's event loop
  // open when the run ends well.
  watchdog = Bun.spawn(["bun", import.meta.path, orphanGuardRegistryPath(process.pid)], {
    env: { PATH: process.env.PATH ?? "" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  watchdog.unref();
}

/**
 * Hands the watchdog one spawned server: `groupLeaderPid` is the pid of a child
 * spawned with `detached: true` (see the contract above) and `root` the scratch
 * folder of that server, removed with it. Call it right after the spawn, not
 * after the readiness probe: the window where the probe fails is exactly the
 * window where a cut run leaves the process behind.
 */
export function guardAgainstOrphans(spawned: { groupLeaderPid: number; root?: string }): void {
  ensureWatchdog();
  const state = localState as Registry;
  if (!state.groups.includes(spawned.groupLeaderPid)) state.groups.push(spawned.groupLeaderPid);
  if (spawned.root && !state.roots.includes(spawned.root)) state.roots.push(spawned.root);
  flush();
}

/**
 * Registers a scratch root the moment it is made, before anything spawns into
 * it. A test that only PREPARES a root (a server it may never boot in a run
 * filtered to one `test.only`/`-t`) still owns a folder a cut run can leave
 * behind: `bun test -t` runs every `describe` callback during discovery
 * regardless of which test it later picks, so a root a suite makes at that
 * level exists on disk long before - or even without - the boot that would
 * otherwise register it through `guardAgainstOrphans`.
 */
export function registerOrphanRoot(root: string): void {
  ensureWatchdog();
  const state = localState as Registry;
  if (!state.roots.includes(root)) state.roots.push(root);
  flush();
}

/**
 * Drops a server the test has already stopped itself, so the watchdog does not
 * signal a pid the operating system may have handed to somebody else by then.
 * The root stays registered: it is removed when the run is over either way.
 */
export function releaseFromOrphanGuard(groupLeaderPid: number): void {
  if (!localState) return;
  localState.groups = localState.groups.filter((pid) => pid !== groupLeaderPid);
  flush();
}

/**
 * Tells the watchdog this process is done: call once every server registered
 * here is already stopped and its root already removed (the file's own
 * cleanup, not this). Removes the registry itself instead of waiting for the
 * watchdog to notice the owner is gone - a poll with a 250 ms period that a
 * check run right after this process exits can otherwise catch mid-flight.
 */
export function retireOrphanGuard(): void {
  if (!localState) return;
  try {
    unlinkSync(orphanGuardRegistryPath(localState.owner));
  } catch { /* never flushed, or already gone */ }
  try {
    rmdirSync(ORPHAN_GUARD_DIR);
  } catch { /* other registries still inside, or already gone */ }
  localState = null;
  // The watchdog this process spawned is about to find its registry gone and
  // exit on its own; drop the handle too, so a server registered right after
  // this call (same process, another test file's worth of work) spawns a
  // fresh one instead of trusting one already on its way out.
  watchdog = null;
}

// ── The watchdog side: what the spawned process does ─────────────────────────

/**
 * Polls the registry until its owner is gone, then kills every registered
 * process group and removes every registered scratch root.
 */
export async function runOrphanWatchdog(registryPath: string): Promise<void> {
  const until = Date.now() + MAX_LIFETIME_MS;
  let registry: Registry | null = null;
  while (Date.now() < until) {
    try {
      registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
    } catch {
      // A missing registry means the run removed it: nothing left to watch.
      if (!existsSync(registryPath)) return;
    }
    if (registry && !alive(registry.owner)) break;
    await Bun.sleep(POLL_MS);
  }
  if (!registry) return;
  for (const group of registry.groups) {
    try {
      // The group, never the bare pid: one signal for the server and anything
      // it spawned. It throws for a pid that leads no group, which is the
      // registration contract failing out loud.
      process.kill(-group, "SIGKILL");
    } catch { /* already gone, or never a group leader */ }
  }
  for (const root of registry.roots) {
    if (!root.startsWith(REMOVABLE_PREFIX)) continue;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch { /* a root the run already removed */ }
  }
  try {
    unlinkSync(registryPath);
  } catch { /* removed by the run */ }
  try {
    // Only succeeds once this was the LAST registry in the directory: another
    // watched process still has its own file in there otherwise.
    rmdirSync(ORPHAN_GUARD_DIR);
  } catch { /* other registries still inside, or already gone */ }
}

if (import.meta.main) {
  const registryPath = process.argv[2];
  if (!registryPath) {
    console.error("usage: bun tests/helpers/orphan-guard.ts <registry-path>");
    process.exit(2);
  }
  await runOrphanWatchdog(registryPath);
}
