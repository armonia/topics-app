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
 *
 * A node learns a higher epoch from ONE caller only: the primary that paired
 * it. The pairing request declares that machine's id, and the approval records
 * it next to the device row it creates (the channel). Machine ids are UUIDs
 * minted by each DB, so the id the node stores is the one declared at pairing,
 * and an adoption names that id, never one read from the request.
 *
 * That channel is not frozen at the first pairing: a primary really does get
 * replaced. A pairing the owner of this machine approves takes the channel over
 * when it declares an epoch above the one this node adopted, and only the
 * chosen primary of a fleet declares an epoch at all.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { writeFileAtomic } from "./atomic-write";
import { bestEffortWrite } from "../db";

export const PRIMARY_EPOCH_HEADER = "x-topics-primary-epoch";
/** Sent with a pairing request: the machine id of the server asking to coordinate this one. */
export const PAIRING_MACHINE_HEADER = "x-topics-machine-id";
/**
 * Sent with the epoch: the machine id of the primary that declares it. After a
 * switch the new primary talks to the nodes with the tokens its predecessor
 * paired, so the channel names the OLD machine; the id has to travel with the
 * epoch or every node adopts the new epoch under the wrong primary.
 */
export const PRIMARY_MACHINE_HEADER = "x-topics-primary-machine";
export const STALE_EPOCH_CODE = "stale_primary_epoch";

export interface PrimaryState {
  primaryMachineId: string | null;
  epoch: number;
  since: string | null;
}

/** The primary that paired this server: the device its calls authenticate as, and the machine id it declared. */
export interface PrimaryChannel {
  deviceId: string;
  machineId: string;
}

/**
 * What a pairing request declared, as the approval saw it: the machine asking
 * to coordinate this one, and the epoch it claims. The epoch is null when the
 * caller declared none, which is what a secondary does.
 */
export interface PairingClaim extends PrimaryChannel {
  epoch?: number | null;
}

export interface PrimaryRole {
  state(): PrimaryState;
  /** True when no primary was ever chosen (single computer) or the choice is this machine. */
  isPrimary(): boolean;
  epoch(): number;
  /** Record a new primary. Refuses an epoch below the current one; same epoch must name the same machine. */
  adopt(next: { primaryMachineId: string; epoch: number }): PrimaryState;
  /**
   * A 409 for a request carrying a lower epoch than ours, else null. An absent,
   * empty or unparsable header means "not declared", never 0. It never changes
   * the state, so it may run before authentication.
   */
  rejectStale(req: Request): Response | null;
  /**
   * Adopt the higher epoch a request declares. `caller` is the identity the
   * access gate resolved: only the channel's device moves the epoch, and the
   * primary it names is the machine the request declares next to the epoch
   * (the channel's machine when it declares none). Loopback, other devices and
   * anonymous callers change nothing. Every adoption writes a `[primary]` log
   * line. Returns true when adopted.
   */
  adoptFrom(req: Request, caller: { deviceId: string | null } | null): boolean;
  /** The primary that paired this server, or null. */
  channel(): PrimaryChannel | null;
  /** Record the primary that just paired this server (called by the pairing approval). */
  recordChannel(next: PairingClaim): void;
  /** Headers an outgoing call carries: the epoch and this machine id, only while this server is the chosen primary. */
  outgoingHeaders(): Record<string, string>;
  /**
   * Headers a pairing request carries, only while this server is the chosen
   * primary: its machine id, so the node can record its channel, and its epoch,
   * which is what lets a NEW primary take a channel its predecessor holds.
   */
  pairingHeaders(): Record<string, string>;
}

export interface PrimaryRoleDeps {
  db: Database;
  stateFile: string;
  localMachineId: () => string;
  now?: () => string;
  log?: (line: string) => void;
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

function readChannel(db: Database): PrimaryChannel | null {
  const row = db.query("SELECT channel_device_id, channel_machine_id FROM primary_state WHERE id = 1").get() as
    { channel_device_id: string | null; channel_machine_id: string | null } | null;
  return row?.channel_device_id && row.channel_machine_id
    ? { deviceId: row.channel_device_id, machineId: row.channel_machine_id }
    : null;
}

function writeDb(db: Database, s: PrimaryState): void {
  db.query(
    "INSERT INTO primary_state (id, primary_machine_id, epoch, since) VALUES (1, ?, ?, ?) "
    + "ON CONFLICT(id) DO UPDATE SET primary_machine_id = excluded.primary_machine_id, epoch = excluded.epoch, since = excluded.since",
  ).run(s.primaryMachineId, s.epoch, s.since);
}

/** The primary machine id a request declares next to its epoch, or null when absent or implausible. */
function declaredMachine(req: Request): string | null {
  const raw = req.headers.get(PRIMARY_MACHINE_HEADER)?.trim();
  return raw && raw.length <= 128 ? raw : null;
}

/** The epoch a request declares, or null when the header is absent, empty or not a whole number. */
function declaredEpoch(req: Request): number | null {
  const raw = req.headers.get(PRIMARY_EPOCH_HEADER)?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

function staleResponse(current: number, presented: number): Response {
  return new Response(
    JSON.stringify({ code: STALE_EPOCH_CODE, error: "This primary was replaced by a newer epoch", epoch: current, presented }),
    { status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

export function createPrimaryRole(deps: PrimaryRoleDeps): PrimaryRole {
  const now = deps.now ?? (() => new Date().toISOString());
  // Read once: a hostname change must not turn this server into a secondary in silence.
  let localId: string | null = null;
  const localMachineId = () => (localId ??= deps.localMachineId());
  const persist = (s: PrimaryState) => {
    mkdirSync(dirname(deps.stateFile), { recursive: true });
    // File first: if the DB write fails the file already holds the newer epoch and boot repairs the DB.
    writeFileAtomic(deps.stateFile, JSON.stringify(s));
    // Under the primary switch fence the DB is read-only on purpose, and the handing-over server adopts the
    // new primary after the fence is up: the file above is the record, the DB copy is skipped, not an error.
    bestEffortWrite(() => writeDb(deps.db, s));
  };

  const log = deps.log ?? ((line: string) => console.warn(line));

  const fromFile = readStateFile(deps.stateFile);
  const fromDb = readDb(deps.db);
  let current = fromFile && fromFile.epoch > fromDb.epoch ? fromFile : fromDb;
  // Nothing chosen yet: nothing to write. A repair that cannot be written is
  // logged and the server boots with what it read; a full disk or a read-only
  // folder must never stop the server.
  const configured = current.epoch > 0 || current.primaryMachineId !== null;
  const outOfStep = fromFile?.epoch !== current.epoch || fromDb.epoch !== current.epoch;
  if (configured && outOfStep) {
    try {
      persist(current);
    } catch (err) {
      log(`[primary] could not write the primary state, booting with epoch ${current.epoch}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const role: PrimaryRole = {
    state: () => ({ ...current }),
    isPrimary: () => current.primaryMachineId === null || current.primaryMachineId === localMachineId(),
    epoch: () => current.epoch,
    adopt(next) {
      if (!next.primaryMachineId) throw new Error("primary machine id is required");
      if (!Number.isInteger(next.epoch) || next.epoch < current.epoch) {
        throw new Error(`epoch ${next.epoch} is below the current ${current.epoch}`);
      }
      if (next.epoch === current.epoch && current.primaryMachineId !== null && current.primaryMachineId !== next.primaryMachineId) {
        throw new Error(`epoch ${next.epoch} already belongs to another primary`);
      }
      const chosen = { primaryMachineId: next.primaryMachineId, epoch: next.epoch, since: now() };
      // Persist first: a write that fails leaves the role it had, in memory too.
      persist(chosen);
      current = chosen;
      return { ...current };
    },
    rejectStale(req) {
      const presented = declaredEpoch(req);
      if (presented === null || presented >= current.epoch) return null;
      return staleResponse(current.epoch, presented);
    },
    adoptFrom(req, caller) {
      const presented = declaredEpoch(req);
      if (presented === null || presented <= current.epoch) return false;
      const ch = readChannel(deps.db);
      if (!ch || !caller?.deviceId || caller.deviceId !== ch.deviceId) return false;
      // The id travels with the epoch: after a switch the channel still names the machine that paired the token.
      const id = declaredMachine(req) ?? ch.machineId;
      try {
        const from = current.epoch;
        role.adopt({ primaryMachineId: id, epoch: presented });
        log(`[primary] adopted epoch ${presented} from ${id} (was ${from}): this server is ${role.isPrimary() ? "the primary" : "a secondary"}`);
        return true;
      } catch (err) {
        log(`[primary] epoch ${presented} from ${id} not adopted: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },
    channel: () => readChannel(deps.db),
    recordChannel(next) {
      // An existing channel changes hands in three cases, and in no other:
      //
      //  - the machine that already holds it pairs again (a new device row for
      //    the same server, after a revoke or a second pairing);
      //  - the pairing comes from the primary this server already recognizes,
      //    which is reclaiming its channel from someone who took it;
      //  - the pairing declares an epoch ABOVE the one this server adopted.
      //    That last one is how a legitimate change of primary reaches a node
      //    whose old primary is gone: without it the FIRST pairing would own
      //    the channel for ever and no later primary could ever be adopted.
      //    It is not an open door: the owner of this machine approved that
      //    pairing by hand, and only the chosen primary declares an epoch at
      //    all (see `pairingHeaders`), so a secondary is left out.
      const existing = readChannel(deps.db);
      const declared = typeof next.epoch === "number" && Number.isInteger(next.epoch) ? next.epoch : null;
      const takesOver = declared !== null && declared > current.epoch;
      if (existing && existing.machineId !== next.machineId && current.primaryMachineId !== next.machineId && !takesOver) {
        log(`[primary] pairing from ${next.machineId} at epoch ${declared ?? "none"} ignored: the channel belongs to ${existing.machineId} and this server is at epoch ${current.epoch}`);
        return;
      }
      deps.db.query("UPDATE primary_state SET channel_device_id = ?, channel_machine_id = ? WHERE id = 1").run(next.deviceId, next.machineId);
      log(`[primary] paired by machine ${next.machineId}: a higher epoch is now adopted only from its device ${next.deviceId}`);
    },
    // A server that is not the chosen primary sends nothing: its node would record the wrong machine.
    outgoingHeaders: (): Record<string, string> => (current.epoch > 0 && current.primaryMachineId === localMachineId()
      ? { [PRIMARY_EPOCH_HEADER]: String(current.epoch), [PRIMARY_MACHINE_HEADER]: localMachineId() }
      : {}),
    // Same criterion as `outgoingHeaders`, minus the epoch>0 guard: a virgin
    // installation (no primary chosen yet) is its own primary and must still be
    // able to pair its first devices and record itself as their channel. The
    // epoch rides along when there is one, so a node can tell a new primary
    // from a server that merely paired it first.
    pairingHeaders: (): Record<string, string> => (current.primaryMachineId === null || current.primaryMachineId === localMachineId()
      ? {
        [PAIRING_MACHINE_HEADER]: localMachineId(),
        ...(current.epoch > 0 ? { [PRIMARY_EPOCH_HEADER]: String(current.epoch) } : {}),
      }
      : {}),
  };
  return role;
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

/**
 * The gate of `/api/nodes/*`: a call from a primary that was replaced (lower epoch) is refused
 * before it touches a card, and a higher epoch is adopted only from the device of the primary
 * that paired this server, as the access gate authenticated it. Loopback and every other
 * device change nothing.
 */
export function guardNodesCall(req: Request, caller: { deviceId: string | null } | null): Response | null {
  const stale = active?.rejectStale(req) ?? null;
  if (!stale) {
    active?.adoptFrom(req, caller);
    noteCallFromPrimary(req, caller);
  }
  return stale;
}

let lastPrimaryCallAt: number | null = null;

/**
 * An authenticated `/api/nodes/*` call that declares the epoch and the machine
 * this server recognizes as the primary: the primary is alive right now. Kept
 * in memory and never throttled, so `primary claim` reads a signal at most one
 * probe round old (track T9). Loopback calls and other devices change nothing.
 */
function noteCallFromPrimary(req: Request, caller: { deviceId: string | null } | null): void {
  if (!active || !caller?.deviceId) return;
  const state = active.state();
  if (state.epoch === 0 || declaredEpoch(req) !== state.epoch) return;
  if (!state.primaryMachineId || declaredMachine(req) !== state.primaryMachineId) return;
  lastPrimaryCallAt = Date.now();
}

/** When the primary last called this server since it started, in ms since the epoch; null when it never did. */
export function lastCallFromPrimary(): number | null {
  return lastPrimaryCallAt;
}

/** Tests only: forget the last call. */
export function resetLastCallFromPrimary(): void {
  lastPrimaryCallAt = null;
}

let internalWritesFenced = false;

/**
 * Set by the switch fence: from the DB snapshot on, this server's own writers
 * (scheduled jobs, the dispatcher reconcile and its node polls) stop as if it
 * were a secondary, so nothing lands in a DB that is being handed over.
 */
export function fenceInternalWrites(on: boolean): void {
  internalWritesFenced = on;
}

let bootHold = false;

/**
 * A primary that boots after being away (track T9) does not know yet whether a
 * node claimed the primary while it was off. Its own writers, and the writes
 * of the interface (`bootHoldRefusal`), stay off until a paired node answered
 * a call that carried this server's epoch, or refused it with a newer one
 * (then this server retires). No timer ends it: a tunnel that comes back an
 * hour later is exactly the case where writing first would split the data.
 * `bun run primary release` lets a person end it when the nodes are gone.
 */
export function holdInternalWritesUntilNodesAnswer(): void {
  bootHold = true;
}

export function releaseBootHold(): void {
  bootHold = false;
}

export function isBootHoldActive(): boolean {
  return bootHold;
}

export function isThisServerPrimary(): boolean {
  if (internalWritesFenced || bootHold) return false;
  return active ? active.isPrimary() : true;
}

type StaleAnswerHandler = (url: string, body: unknown) => void;
let staleAnswerHandler: StaleAnswerHandler | null = null;

/** Wired at boot by `primary-replaced.ts`: what to do when a node says this primary was replaced. */
export function onStaleAnswer(handler: StaleAnswerHandler | null): void {
  staleAnswerHandler = handler;
}

/** Called by the node client on every 409 it receives, with the parsed body. */
export function reportStaleAnswer(url: string, body: unknown): void {
  staleAnswerHandler?.(url, body);
}
