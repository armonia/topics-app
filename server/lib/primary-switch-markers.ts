/**
 * The two marker files of a primary switch (track T4 of
 * `openspec/changes/nodo-principale-a-mano`): where the server that hands the
 * primary over stands, and the receiver's answer to "did the restore of epoch N
 * succeed?", written at its boot and read by the sender before it retires. Only
 * the holder of the confirmation secret, whose hash the manifest carried, can
 * read that answer as a confirmation.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write";

/** Next to `primary-state.json`: present on a server that handed the primary over. */
export const RETIRED_FILE = "primary-retired.json";
/** Next to `primary-state.json` on the receiver. */
export const RESTORE_STATUS_FILE = "primary-restore.json";

/**
 * Where a server that is handing (or handed) the primary over stands. Every
 * phase but the last refuses EVERY client write, sign-in and node routes
 * included, because the data still on this disk is the data that moved:
 *
 *  - `fencing`: the switch is running; in memory only, a refusal undoes it;
 *  - `sent`: the commit is on its way. Written to disk BEFORE it leaves, so a
 *    crash or a lost answer can never boot this server back as the primary;
 *  - `uncertain`: the commit got no usable answer. Stays until a person checks
 *    the other computer (`bun run primary reclaim` if it did not take over);
 *  - `pending-set-aside`: the other computer took over; the next boot renames
 *    this DB and state aside;
 *  - `set-aside`: done. This server runs as a secondary on a service DB of its
 *    own (`topics.retired.db`, never `topics.db`: a replica of that path must
 *    find nothing to publish), so the node and pairing routes open again (how
 *    it becomes a node of the new one).
 */
export type RetiredPhase = "fencing" | "sent" | "uncertain" | "pending-set-aside" | "set-aside";
const RETIRED_PHASES: readonly RetiredPhase[] = ["fencing", "sent", "uncertain", "pending-set-aside", "set-aside"];

export interface RetiredState {
  epoch: number;
  toMachineId: string;
  toName: string | null;
  at: string;
  phase: RetiredPhase;
}

export function readRetired(appDataDir: string): RetiredState | null {
  try {
    const raw = JSON.parse(readFileSync(join(appDataDir, RETIRED_FILE), "utf-8")) as Partial<RetiredState>;
    if (!Number.isInteger(raw.epoch) || typeof raw.toMachineId !== "string" || !raw.toMachineId) return null;
    // A marker with a phase this code does not know is the strictest one we have: never a reason to open the door.
    const phase = RETIRED_PHASES.includes(raw.phase as RetiredPhase) && raw.phase !== "fencing" ? raw.phase as RetiredPhase : "uncertain";
    return {
      epoch: raw.epoch as number,
      toMachineId: raw.toMachineId,
      toName: typeof raw.toName === "string" ? raw.toName : null,
      at: typeof raw.at === "string" ? raw.at : "",
      phase,
    };
  } catch {
    return null;
  }
}

export function writeRetired(appDataDir: string, state: RetiredState): void {
  mkdirSync(appDataDir, { recursive: true });
  writeFileAtomic(join(appDataDir, RETIRED_FILE), JSON.stringify(state));
}

/**
 * Where the receiver stands after a commit, for the sender that waits on it:
 * `committed` until the boot ran the restore, then `restored` (with a warning
 * when the replica did not start again) or `failed` with the reason.
 */
export interface RestoreStatus {
  epoch: number;
  confirmSha256: string;
  state: "committed" | "restored" | "failed";
  error?: string;
  warning?: string;
  at: string;
}

export function readRestoreStatus(appDataDir: string): RestoreStatus | null {
  try {
    const raw = JSON.parse(readFileSync(join(appDataDir, RESTORE_STATUS_FILE), "utf-8")) as Partial<RestoreStatus>;
    if (!Number.isInteger(raw.epoch) || typeof raw.confirmSha256 !== "string") return null;
    if (raw.state !== "committed" && raw.state !== "restored" && raw.state !== "failed") return null;
    return raw as RestoreStatus;
  } catch {
    return null;
  }
}

export function writeRestoreStatus(appDataDir: string, status: Omit<RestoreStatus, "at">, now: () => string): void {
  mkdirSync(appDataDir, { recursive: true });
  writeFileAtomic(join(appDataDir, RESTORE_STATUS_FILE), JSON.stringify({ ...status, at: now() }));
}

export function clearRestoreStatus(appDataDir: string): void {
  rmSync(join(appDataDir, RESTORE_STATUS_FILE), { force: true });
}

/** True when `secret` is the one whose hash the status carries; constant time. */
export function confirmsRestore(status: Pick<RestoreStatus, "confirmSha256">, secret: string): boolean {
  const a = Buffer.from(createHash("sha256").update(secret).digest("hex"));
  const b = Buffer.from(status.confirmSha256);
  return a.length === b.length && timingSafeEqual(a, b);
}
