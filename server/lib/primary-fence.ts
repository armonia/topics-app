/**
 * The client write fence of a server that handed the primary over (track T4).
 * Up from the moment a switch freezes the DB for its copy, and for good once the
 * other computer took over: the front door answers every client write with
 * `primary_moved` instead of writing into data that now lives elsewhere.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveAppDataDir, resolveDataDir, resolveStateDir } from "./data-dir";
import { applyPendingPrimaryChange, DB_NAME, isRefusedWhenRetired, movedResponse, readRetired, type RetiredState } from "./primary-switch";

let fence: RetiredState | null = null;

export function setPrimaryFence(next: RetiredState | null): void {
  fence = next;
}

/** The front door's check: the `primary_moved` answer for a client write while the fence is up, else null. */
export function retiredRefusal(pathname: string, method: string): Response | null {
  return fence && isRefusedWhenRetired(pathname, method) ? movedResponse(fence) : null;
}

/**
 * The boot half, BEFORE the DB opens: a committed bundle is restored, or the DB
 * of a server that handed over is set aside; then the fence is read from the
 * retired marker. The paths come from the same functions `createAppContext`
 * uses. A failure is logged and the server boots on what is there.
 */
export function bootPrimaryChange(rootDir: string): void {
  const stateDir = resolveStateDir(rootDir);
  const appDataDir = resolveAppDataDir();
  try {
    applyPendingPrimaryChange({
      stateDir,
      dbPath: join(resolveDataDir(stateDir), DB_NAME),
      appDataDir,
      projectsDir: join(homedir(), ".claude", "projects"),
    });
  } catch (err) {
    console.error(`[primary] the pending primary change could not be applied: ${err instanceof Error ? err.message : String(err)}`);
  }
  fence = readRetired(appDataDir);
  if (fence) console.warn(`[primary] this server handed the primary over to ${fence.toName ?? fence.toMachineId} at epoch ${fence.epoch}: client writes are refused`);
}

/**
 * A graceful restart a moment from now, so the answer in flight is flushed
 * first. The SIGTERM runs the normal shutdown, and whatever supervises the
 * server (start-prod.sh, launchd, systemd) starts it again.
 */
export function restartThisServerSoon(): void {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
}
