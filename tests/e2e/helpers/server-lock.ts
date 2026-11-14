/**
 * A cross-process mutex over the ONE test server.
 *
 * WHY. Every spec file opens with `hermetic()`, which restores the whole DB to
 * the globalSetup baseline (`POST /api/test/reset`), and the pane store is a
 * single `ui_state` row for the whole server. With two workers, one worker's
 * reset or pane seed lands in the middle of the other worker's file: its topics
 * are gone, its project pane is gone, and the failures show up as "Processi"
 * never appearing or a tab that is not there (file-context-menu,
 * file-explorer-panels, file-explorer, tab-notifications at --workers=2).
 * The state is shared, so a file holds this lock from its `beforeAll` to its
 * `afterAll` and files take turns on the server.
 *
 * The lock is a directory created with `mkdir` (atomic on every platform) that
 * holds the owner's PID, so a worker killed mid-file does not wedge the others.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const POLL_MS = 100;
const WAIT_MS = 10 * 60_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerOf(dir: string): number | null {
  try {
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function lockDirFor(key: string): string {
  return join(tmpdir(), `topics-e2e-server-${key.replace(/[^a-z0-9]+/gi, "_")}.lock`);
}

/** Resolves once this process owns the lock; returns the release function. */
export async function acquireServerLock(key: string, waitMs = WAIT_MS): Promise<() => void> {
  const dir = lockDirFor(key);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const owner = ownerOf(dir);
    if (owner === process.pid) return () => rmSync(dir, { recursive: true, force: true });
    // The pid file is written right after mkdir: no pid yet means "being taken", not "stale".
    if (owner !== null && !isAlive(owner)) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`server lock ${dir} still held by pid ${owner} after ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
