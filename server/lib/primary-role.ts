/**
 * Which computer is the primary, and in which epoch.
 *
 * The primary runs the dispatcher, the scheduled cards and the hub reader; every
 * other server stays quiet. The epoch only goes up, and whoever presents a lower
 * one than ours is a primary that was replaced and has not noticed yet: its
 * calls are refused with `stale_primary_epoch` instead of being applied.
 *
 * The choice is a machine id (`machines.id`), never a name. It lives in the DB
 * AND in a state file written FIRST: the file survives a DB that is swapped or
 * restored, and at boot the higher epoch of the two wins.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { writeFileAtomic } from "./atomic-write";

export const PRIMARY_EPOCH_HEADER = "x-topics-primary-epoch";
export const STALE_EPOCH_CODE = "stale_primary_epoch";

export interface PrimaryState {
  primaryMachineId: string | null;
  epoch: number;
  since: string | null;
}

export interface PrimaryRole {
  state(): PrimaryState;
  /** True when no primary was ever chosen (single computer) or the choice is this machine. */
  isPrimary(): boolean;
  epoch(): number;
  /** Record a new primary. Refuses an epoch below the current one; same epoch must name the same machine. */
  adopt(next: { primaryMachineId: string; epoch: number }): PrimaryState;
  /** A 409 for a request carrying a lower epoch than ours, else null (no header counts as unknown, not lower). */
  rejectStale(req: Request): Response | null;
}

export interface PrimaryRoleDeps {
  db: Database;
  stateFile: string;
  localMachineId: () => string;
  now?: () => string;
}

function readStateFile(file: string): PrimaryState | null {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<PrimaryState> | null;
    if (!raw || typeof raw !== "object" || !Number.isInteger(raw.epoch) || (raw.epoch as number) < 0) return null;
    const id = typeof raw.primaryMachineId === "string" && raw.primaryMachineId ? raw.primaryMachineId : null;
    return { primaryMachineId: id, epoch: raw.epoch as number, since: typeof raw.since === "string" ? raw.since : null };
  } catch {
    return null;
  }
}

function readDb(db: Database): PrimaryState {
  const row = db.query("SELECT primary_machine_id, epoch, since FROM primary_state WHERE id = 1").get() as
    { primary_machine_id: string | null; epoch: number; since: string | null } | null;
  return row
    ? { primaryMachineId: row.primary_machine_id, epoch: row.epoch, since: row.since }
    : { primaryMachineId: null, epoch: 0, since: null };
}

function writeDb(db: Database, s: PrimaryState): void {
  db.query(
    "INSERT INTO primary_state (id, primary_machine_id, epoch, since) VALUES (1, ?, ?, ?) "
    + "ON CONFLICT(id) DO UPDATE SET primary_machine_id = excluded.primary_machine_id, epoch = excluded.epoch, since = excluded.since",
  ).run(s.primaryMachineId, s.epoch, s.since);
}

function staleResponse(current: number, presented: number): Response {
  return new Response(
    JSON.stringify({ code: STALE_EPOCH_CODE, error: "This primary was replaced by a newer epoch", epoch: current, presented }),
    { status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

export function createPrimaryRole(deps: PrimaryRoleDeps): PrimaryRole {
  const now = deps.now ?? (() => new Date().toISOString());
  const persist = (s: PrimaryState) => {
    // File first: if the DB write fails the file already holds the newer epoch and boot repairs the DB.
    writeFileAtomic(deps.stateFile, JSON.stringify(s));
    writeDb(deps.db, s);
  };

  const fromFile = readStateFile(deps.stateFile);
  const fromDb = readDb(deps.db);
  let current = fromFile && fromFile.epoch > fromDb.epoch ? fromFile : fromDb;
  if (fromFile === null || fromFile.epoch !== current.epoch || fromDb.epoch !== current.epoch) persist(current);

  return {
    state: () => ({ ...current }),
    isPrimary: () => current.primaryMachineId === null || current.primaryMachineId === deps.localMachineId(),
    epoch: () => current.epoch,
    adopt(next) {
      if (!next.primaryMachineId) throw new Error("primary machine id is required");
      if (!Number.isInteger(next.epoch) || next.epoch < current.epoch) {
        throw new Error(`epoch ${next.epoch} is below the current ${current.epoch}`);
      }
      if (next.epoch === current.epoch && current.primaryMachineId !== null && current.primaryMachineId !== next.primaryMachineId) {
        throw new Error(`epoch ${next.epoch} already belongs to another primary`);
      }
      current = { primaryMachineId: next.primaryMachineId, epoch: next.epoch, since: now() };
      persist(current);
      return { ...current };
    },
    rejectStale(req) {
      const raw = req.headers.get(PRIMARY_EPOCH_HEADER);
      if (raw === null) return null;
      const presented = Number(raw);
      if (!Number.isInteger(presented) || presented < 0 || presented >= current.epoch) return null;
      return staleResponse(current.epoch, presented);
    },
  };
}

let active: PrimaryRole | null = null;

export function initPrimaryRole(deps: PrimaryRoleDeps): PrimaryRole {
  active = createPrimaryRole(deps);
  return active;
}

/** Null before boot wired it (and in tests that do not care): callers then behave as the sole primary. */
export function getPrimaryRole(): PrimaryRole | null {
  return active;
}

export function isThisServerPrimary(): boolean {
  return active ? active.isPrimary() : true;
}
