/**
 * The client write fence of a server that is handing, or handed, the primary
 * over (track T4). Up from the moment a switch freezes the DB for its copy, and
 * for good once the commit has left: the front door answers with
 * `primary_moved` instead of writing into data that now lives elsewhere.
 *
 * The fence is read from `primary-retired.json` at every boot, and a marker on
 * disk also keeps the ROLE a secondary (`holdRetiredRole`): a server that sent
 * its commit never boots back as the primary, whatever the answer was.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync } from "node:fs";
import { resolveAppDataDir, resolveDataDir, resolveSecretsDir, resolveStateDir } from "./data-dir";
import {
  applyPendingPrimaryChange, DB_NAME, isRefusedWhenRetired, movedResponse, readRetired, RETIRED_FILE,
  type RetiredState,
} from "./primary-switch";
import type { PrimaryRole } from "./primary-role";

let fence: RetiredState | null = null;

export function setPrimaryFence(next: RetiredState | null): void {
  fence = next;
}

/** The front door's check: the `primary_moved` answer for a refused request while the fence is up, else null. */
export function retiredRefusal(pathname: string, method: string): Response | null {
  return fence && isRefusedWhenRetired(pathname, method, fence.phase) ? movedResponse(fence) : null;
}

/**
 * The front door's entry check: the access gate first, the fence after it. A
 * caller the gate refuses gets the gate's answer, so nobody unauthenticated
 * learns which computer is the primary now; an authenticated write on a
 * fenced server gets `primary_moved`.
 */
export function gatedRefusal(accessGate: () => Response | null, pathname: string, method: string): Response | null {
  return accessGate() ?? retiredRefusal(pathname, method);
}

/** What `bootPrimaryChange` needs to know; the defaults are the paths `createAppContext` uses. */
export interface BootPrimaryPaths {
  stateDir: string;
  appDataDir: string;
  secretsDir?: string;
  dbPath?: string;
  projectsDir?: string;
}

/**
 * The boot half, BEFORE the DB opens: a committed bundle is restored, or the DB
 * of a server that handed over is set aside; then the fence is read from the
 * retired marker. A failure is logged and the server boots on what is there,
 * still fenced if a marker says so.
 */
export function bootPrimaryChange(rootDir: string, paths?: BootPrimaryPaths): void {
  const stateDir = paths?.stateDir ?? resolveStateDir(rootDir);
  const appDataDir = paths?.appDataDir ?? resolveAppDataDir();
  try {
    applyPendingPrimaryChange({
      stateDir,
      secretsDir: paths?.secretsDir ?? resolveSecretsDir(stateDir),
      dbPath: paths?.dbPath ?? join(resolveDataDir(stateDir), DB_NAME),
      appDataDir,
      projectsDir: paths?.projectsDir ?? join(homedir(), ".claude", "projects"),
    });
  } catch (err) {
    console.error(`[primary] the pending primary change could not be applied: ${err instanceof Error ? err.message : String(err)}`);
  }
  fence = readRetired(appDataDir);
  if (fence) console.warn(`[primary] this server handed the primary over to ${fence.toName ?? fence.toMachineId} at epoch ${fence.epoch} (${fence.phase}): client writes are refused`);
}

/**
 * Right after the role is read at boot: a retired marker wins over a role that
 * still says "primary". That is the case of a commit sent whose answer never
 * came (or a crash right after it): the epoch file was never moved on, and
 * without this the server would boot back as the primary next to the new one.
 */
export function holdRetiredRole(role: Pick<PrimaryRole, "isPrimary" | "adopt">, log: (line: string) => void = (l) => console.warn(l)): void {
  if (!fence || !role.isPrimary()) return;
  try {
    role.adopt({ primaryMachineId: fence.toMachineId, epoch: fence.epoch });
    log(`[primary] retired marker found (${fence.phase}): this server boots as a secondary of ${fence.toMachineId} at epoch ${fence.epoch}`);
  } catch (err) {
    // The fence stays up either way: refusing writes is what keeps the data whole.
    log(`[primary] retired marker found but the role could not follow it: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type ReclaimResult = { ok: true; epoch: number } | { ok: false; code: string; error: string };

/**
 * `bun run primary reclaim`: the way out of `uncertain` (or `sent`), once a
 * person checked that the other computer did NOT take over. This server adopts
 * itself at an epoch above any the switch used, drops the marker and restarts.
 * Refused in every other phase: a switch that succeeded is never undone here.
 */
export function reclaimPrimary(deps: {
  appDataDir: string;
  role: Pick<PrimaryRole, "epoch" | "adopt">;
  localMachineId: string;
  restart: () => void;
}): ReclaimResult {
  const marker = readRetired(deps.appDataDir);
  if (!marker) return { ok: false, code: "not_retired", error: "this server did not hand the primary over" };
  if (marker.phase !== "uncertain" && marker.phase !== "sent") {
    return { ok: false, code: "not_uncertain", error: `the switch to ${marker.toName ?? marker.toMachineId} is ${marker.phase}: it cannot be taken back` };
  }
  const epoch = Math.max(marker.epoch, deps.role.epoch()) + 1;
  deps.role.adopt({ primaryMachineId: deps.localMachineId, epoch });
  rmSync(join(deps.appDataDir, RETIRED_FILE), { force: true });
  fence = null;
  deps.restart();
  return { ok: true, epoch };
}

/**
 * A graceful restart a moment from now, so the answer in flight is flushed
 * first. The SIGTERM runs the normal shutdown, and whatever supervises the
 * server (start-prod.sh, launchd, systemd) starts it again.
 */
export function restartThisServerSoon(): void {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
}
