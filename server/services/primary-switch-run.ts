/**
 * `primary switch <machine>`, run on the current primary (track T4 of
 * `openspec/changes/nodo-principale-a-mano`). The order is the guarantee:
 *
 *  1. drain: no new card starts; the work in flight finishes, or is parked
 *     back in the queue with a note once the wait is over;
 *  2. fence: from here every request that writes is refused (sign-in and node
 *     routes included), so a write made during the drain is in the copy and a
 *     write after it is never accepted and then lost;
 *  3. snapshot + `integrity_check` + row counts, which must equal the live DB's;
 *  4. ship the DB, the state files and the transcripts;
 *  5. the `sent` marker goes to disk, THEN the commit leaves: the new primary
 *     checks every hash, the integrity and the counts, and that it can write
 *     every folder and stop its replica, before it agrees;
 *  6. accepted: this server waits, still fenced, until the receiver restarted
 *     and says it is the primary. A restore that failed there is dropped and
 *     this server stays the primary;
 *  7. confirmed: this server records the new primary at epoch+1, marks itself
 *     `pending-set-aside` and restarts, and the boot sets its DB aside.
 *
 * A refusal before the commit, or an explicit no to it, undoes everything and
 * leaves this server the primary, as if nothing happened. A commit whose answer
 * never came is NOT undone: the other computer may already be the primary, and
 * two primaries is the one outcome worse than a stopped one. That case records
 * `uncertain` on disk, gives up the role and stays fenced across restarts until
 * a person checks the other computer (`bun run primary reclaim`).
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type BundleSource, type RetiredState, type RowCounts, type SwitchManifest,
  collectAttachmentFiles, collectStateFiles, collectTranscripts, countRows, DB_NAME, OUTGOING_DIR, sameCounts, sha256File,
  RETIRED_FILE, snapshotDatabase, writeRetired,
} from "../lib/primary-switch";
import type { PrimaryRole } from "../lib/primary-role";
import { resolveDataDir } from "../lib/data-dir";

/** The target, as the machines table knows it. */
export interface SwitchTarget { id: string; hostname: string; name: string }

/** Something still working when the drain began: a card (with its task) or a chat. */
/** A card turn, a chat stream, or a scheduled job run (`scheduledJobId`): what a drain waits for or parks. */
export interface WorkInFlight { taskId?: string; scheduledJobId?: string; sessionKey: string }

/** What the receiver said to the commit. `refused` is an explicit no: safe to undo. */
export type CommitAnswer =
  | { kind: "accepted"; counts: RowCounts }
  | { kind: "refused"; code: string; error: string }
  | { kind: "unknown"; error: string };

/**
 * What the receiver says, asked with the commit's one-time secret, once it
 * restarted: `restored` (it is the primary; `warning` when its replica did not
 * start again), `failed` with the reason, or `waiting` (still restarting,
 * unreachable, or not run the restore yet).
 */
export type ConfirmAnswer =
  | { kind: "restored"; warning?: string }
  | { kind: "failed"; error: string }
  | { kind: "waiting" };

export interface PrimarySwitchDeps {
  db: Pick<Database, "query">;
  stateDir: string;
  secretsDir: string;
  appDataDir: string;
  projectsDir: string;
  /** The data folder inside the state root (views, kept transcripts). Defaults to `resolveDataDir(stateDir)`. */
  dataDir?: string;
  role: Pick<PrimaryRole, "isPrimary" | "epoch" | "adopt">;
  localMachineId: string;
  target: SwitchTarget;
  drain: (reason: string) => void;
  undrain: (reason: string) => void;
  stillWorking: () => WorkInFlight[];
  /** Stops one piece of work for good: the turn is cut and a card goes back to the queue with the note. */
  park: (work: WorkInFlight, note: string) => Promise<void>;
  /** Turns the client write fence on (with the state it answers) or off. */
  setFence: (retired: RetiredState | null) => void;
  upload: (name: string, offset: number, bytes: Uint8Array) => Promise<void>;
  commit: (manifest: SwitchManifest) => Promise<CommitAnswer>;
  /** Asks the receiver how its restore went, with the commit's secret. */
  confirm: (secret: string) => Promise<ConfirmAnswer>;
  /** Tells the receiver to drop a restore that failed; true once it did. */
  abandon: (secret: string) => Promise<boolean>;
  restartSelf: () => void;
  drainTimeoutMs?: number;
  /** How long the receiver has to restart and restore before the switch is `uncertain`. */
  confirmTimeoutMs?: number;
  pollMs?: number;
  chunkBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
  log?: (line: string) => void;
}

export interface SwitchReport {
  ok: boolean;
  /** `refused`: nothing changed. `uncertain`: fenced, check the other computer before anything else. */
  outcome: "switched" | "refused" | "uncertain";
  step: string;
  error?: string;
  /** A switch that succeeded with something for a person to fix on the new primary (its replica did not start). */
  warning?: string;
  epoch?: number;
  target: SwitchTarget;
  counts?: RowCounts;
  parked: string[];
  files?: number;
  transcripts?: number;
  bytes?: number;
}

export const SWITCH_REASON = "primary switch";
export const PARK_NOTE = "Passaggio del principale in corso: la card riparte da capo sul nuovo principale."; // allow-italian: a card note the person reads on the board

const DEFAULT_DRAIN_MS = 15 * 60_000;
/** The receiver copies every attachment before it opens the DB: gigabytes of media take minutes. */
const DEFAULT_CONFIRM_MS = 30 * 60_000;
const DEFAULT_CHUNK = 32 * 1024 * 1024;

async function shipFile(deps: PrimarySwitchDeps, name: string, source: string, chunk: number): Promise<void> {
  let offset = 0;
  const file = Bun.file(source);
  const size = file.size;
  // An empty file still has to exist on the other side.
  if (size === 0) return deps.upload(name, 0, new Uint8Array());
  while (offset < size) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(size, offset + chunk)).arrayBuffer());
    await deps.upload(name, offset, bytes);
    offset += bytes.byteLength;
  }
}

export async function runPrimarySwitch(deps: PrimarySwitchDeps): Promise<SwitchReport> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date().toISOString());
  const { target } = deps;
  const parked: string[] = [];
  const base = { target, parked };

  if (!deps.role.isPrimary()) return { ...base, ok: false, outcome: "refused", step: "check", error: "this server is not the primary" };
  if (target.id === deps.localMachineId) return { ...base, ok: false, outcome: "refused", step: "check", error: "the target is this computer" };

  const epoch = deps.role.epoch() + 1;
  const outgoing = join(deps.stateDir, OUTGOING_DIR);
  let step = "drain";
  let fenced = false;
  const marker = (phase: RetiredState["phase"]): RetiredState => ({ epoch, toMachineId: target.id, toName: target.name, at: now(), phase });
  const undo = (error: string): SwitchReport => {
    rmSync(join(deps.appDataDir, RETIRED_FILE), { force: true });
    if (fenced) deps.setFence(null);
    deps.undrain(SWITCH_REASON);
    rmSync(outgoing, { recursive: true, force: true });
    log(`[primary] switch to ${target.name} refused at ${step}: ${error}; this server stays the primary`);
    return { ...base, ok: false, outcome: "refused", step, error, epoch };
  };
  /**
   * The commit may have been taken: record it on disk, give up the role (a
   * stopped primary beats two), keep the fence, drop the outgoing copy. Each
   * piece is tried on its own so one failure does not skip the others.
   */
  const uncertain = (error: string, counts?: RowCounts): SwitchReport => {
    const state = marker("uncertain");
    deps.setFence(state);
    const attempts: Array<[string, () => void]> = [
      ["marker", () => writeRetired(deps.appDataDir, state)],
      ["role", () => { deps.role.adopt({ primaryMachineId: target.id, epoch }); }],
      ["outgoing", () => rmSync(outgoing, { recursive: true, force: true })],
    ];
    for (const [what, attempt] of attempts) {
      try {
        attempt();
      } catch (err) {
        log(`[primary] switch to ${target.name}: could not record the uncertain ${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(`[primary] switch to ${target.name} at ${step}: ${error}; this server stays fenced and is no longer the primary until the other computer is checked`);
    return { ...base, ok: false, outcome: "uncertain", step, error, epoch, ...(counts ? { counts } : {}) };
  };

  try {
    deps.drain(SWITCH_REASON);
    log(`[primary] switch to ${target.name} (${target.id}) at epoch ${epoch}: drain started`);
    const deadline = Date.now() + (deps.drainTimeoutMs ?? DEFAULT_DRAIN_MS);
    while (deps.stillWorking().length > 0 && Date.now() < deadline) await sleep(deps.pollMs ?? 2_000);
    step = "park";
    for (const work of deps.stillWorking()) {
      await deps.park(work, PARK_NOTE);
      parked.push(work.taskId ?? work.sessionKey);
    }

    // Snapshot and fence in one synchronous block, so no other code of this
    // process runs between them: the copy needs a writable handle (VACUUM INTO),
    // and the fence turns the live handle read-only right after it.
    step = "snapshot";
    const dbCopy = join(outgoing, DB_NAME);
    const counts = snapshotDatabase(deps.db, dbCopy);
    step = "fence";
    deps.setFence(marker("fencing"));
    fenced = true;
    const live = countRows(deps.db);
    if (!sameCounts(counts, live)) return undo(`the copy counts ${JSON.stringify(counts)}, the live DB ${JSON.stringify(live)}`);

    step = "bundle";
    const transcripts = collectTranscripts(deps.db, deps.projectsDir);
    const attachments = collectAttachmentFiles(
      { stateDir: deps.stateDir, appDataDir: deps.appDataDir, dataDir: deps.dataDir ?? resolveDataDir(deps.stateDir) },
      transcripts,
    );
    const sources: BundleSource[] = [{ name: DB_NAME, source: dbCopy }, ...collectStateFiles({ stateDir: deps.stateDir, secretsDir: deps.secretsDir, appDataDir: deps.appDataDir, dataDir: deps.dataDir ?? resolveDataDir(deps.stateDir) }), ...transcripts, ...attachments];
    const files: SwitchManifest["files"] = [];
    let bytes = 0;
    for (const s of sources) {
      const { size, mtimeMs } = statSync(s.source);
      bytes += size;
      files.push({ name: s.name, size, sha256: await sha256File(s.source), mtimeMs });
    }
    // Only its hash travels; the secret stays in this process and asks the receiver how the restore went.
    const secret = randomBytes(32).toString("hex");
    const manifest: SwitchManifest = {
      version: 1, epoch, toMachineId: target.id, toHostname: target.hostname,
      fromMachineId: deps.localMachineId, createdAt: now(), counts, files,
      confirmSha256: createHash("sha256").update(secret).digest("hex"),
    };

    step = "upload";
    for (const s of sources) await shipFile(deps, s.name, s.source, deps.chunkBytes ?? DEFAULT_CHUNK);

    step = "seal";
    // On disk BEFORE the commit leaves: from here a crash, a lost answer or a restart boots fenced and as a secondary.
    const sent = marker("sent");
    writeRetired(deps.appDataDir, sent);
    deps.setFence(sent);

    step = "commit";
    const answer = await deps.commit(manifest);
    if (answer.kind === "refused") return undo(`${answer.code}: ${answer.error}`);
    if (answer.kind === "unknown") return uncertain(`the commit got no answer (${answer.error})`, counts);
    if (!sameCounts(answer.counts, counts)) {
      return uncertain(`the new primary reports ${JSON.stringify(answer.counts)}, the copy ${JSON.stringify(counts)}`, counts);
    }

    // Accepted is not restored: the receiver restarts and copies the files first. This server stays
    // fenced (`sent`) and does not retire until the receiver says it IS the primary; a restore that
    // failed is dropped there and this server stays the primary, so a failure never leaves none.
    step = "confirm";
    let warning: string | undefined;
    const confirmBy = Date.now() + (deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_MS);
    for (;;) {
      const status = await deps.confirm(secret);
      if (status.kind === "restored") { warning = status.warning; break; }
      if (status.kind === "failed") {
        step = "abandon";
        if (!(await deps.abandon(secret))) return uncertain(`the new primary could not restore (${status.error}) and did not drop the copy`, counts);
        return undo(`the new primary could not restore: ${status.error}`);
      }
      if (Date.now() >= confirmBy) return uncertain("the new primary did not confirm the restore in time", counts);
      await sleep(deps.pollMs ?? 2_000);
    }

    step = "retire";
    // The retired marker before the role: a crash in between still boots fenced and sets the DB aside.
    const retired = marker("pending-set-aside");
    writeRetired(deps.appDataDir, retired);
    deps.setFence(retired);
    deps.role.adopt({ primaryMachineId: target.id, epoch });
    rmSync(outgoing, { recursive: true, force: true });
    log(`[primary] handed over to ${target.name} at epoch ${epoch}: ${JSON.stringify(counts)}, ${transcripts.length} transcript files; restarting to set this DB aside`);
    if (warning) log(`[primary] the new primary ${target.name} needs a hand: ${warning}`);
    deps.restartSelf();
    return { ...base, ok: true, outcome: "switched", step, epoch, counts, files: files.length, transcripts: transcripts.length, bytes, ...(warning ? { warning } : {}) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Before the commit was sent nothing left this computer for good: undo. During or after it, do not guess.
    if (step === "commit" || step === "confirm" || step === "abandon" || step === "retire") return uncertain(error);
    return undo(error);
  }
}
