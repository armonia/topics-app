/**
 * `primary switch <machine>`, run on the current primary (track T4 of
 * `openspec/changes/nodo-principale-a-mano`). The order is the guarantee:
 *
 *  1. drain: no new card starts; the work in flight finishes, or is parked
 *     back in the queue with a note once the wait is over;
 *  2. fence: from here every write from a client is refused, so a write made
 *     during the drain is in the copy and a write after it is never accepted
 *     and then lost;
 *  3. snapshot + `integrity_check` + row counts, which must equal the live DB's;
 *  4. ship the DB, the state files and the transcripts, then commit: the new
 *     primary checks every hash, the integrity and the counts before it agrees;
 *  5. only after that answer: this server records the new primary at epoch+1,
 *     marks itself retired and restarts, and the boot sets its DB aside.
 *
 * A refusal before the commit undoes 1 and 2 and leaves this server the
 * primary, as if nothing happened. A commit whose answer never came is NOT
 * undone: the other computer may already be the primary, and two primaries is
 * the one outcome worse than a stopped one. That case stays fenced and says so.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type BundleSource, type RetiredState, type RowCounts, type SwitchManifest,
  collectStateFiles, collectTranscripts, countRows, DB_NAME, OUTGOING_DIR, sameCounts, sha256File,
  snapshotDatabase, writeRetired,
} from "../lib/primary-switch";
import type { PrimaryRole } from "../lib/primary-role";

/** The target, as the machines table knows it. */
export interface SwitchTarget { id: string; hostname: string; name: string }

/** Something still working when the drain began: a card (with its task) or a chat. */
export interface WorkInFlight { taskId?: string; sessionKey: string }

/** What the receiver said to the commit. `refused` is an explicit no: safe to undo. */
export type CommitAnswer =
  | { kind: "accepted"; counts: RowCounts }
  | { kind: "refused"; code: string; error: string }
  | { kind: "unknown"; error: string };

export interface PrimarySwitchDeps {
  db: Pick<Database, "query">;
  stateDir: string;
  appDataDir: string;
  projectsDir: string;
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
  restartSelf: () => void;
  drainTimeoutMs?: number;
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
  const undo = (error: string): SwitchReport => {
    if (fenced) deps.setFence(null);
    deps.undrain(SWITCH_REASON);
    rmSync(outgoing, { recursive: true, force: true });
    log(`[primary] switch to ${target.name} refused at ${step}: ${error}; this server stays the primary`);
    return { ...base, ok: false, outcome: "refused", step, error, epoch };
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

    step = "fence";
    deps.setFence({ epoch, toMachineId: target.id, toName: target.name, at: now(), pendingSetAside: false });
    fenced = true;

    step = "snapshot";
    const dbCopy = join(outgoing, DB_NAME);
    mkdirSync(outgoing, { recursive: true });
    const counts = snapshotDatabase(deps.db, dbCopy);
    const live = countRows(deps.db);
    if (!sameCounts(counts, live)) return undo(`the copy counts ${JSON.stringify(counts)}, the live DB ${JSON.stringify(live)}`);

    step = "bundle";
    const transcripts = collectTranscripts(deps.db, deps.projectsDir);
    const sources: BundleSource[] = [{ name: DB_NAME, source: dbCopy }, ...collectStateFiles(deps.stateDir), ...transcripts];
    const files = [];
    let bytes = 0;
    for (const s of sources) {
      const size = statSync(s.source).size;
      bytes += size;
      files.push({ name: s.name, size, sha256: await sha256File(s.source) });
    }
    const manifest: SwitchManifest = {
      version: 1, epoch, toMachineId: target.id, toHostname: target.hostname,
      fromMachineId: deps.localMachineId, createdAt: now(), counts, files,
    };

    step = "upload";
    for (const s of sources) await shipFile(deps, s.name, s.source, deps.chunkBytes ?? DEFAULT_CHUNK);

    step = "commit";
    const answer = await deps.commit(manifest);
    if (answer.kind === "refused") return undo(`${answer.code}: ${answer.error}`);
    if (answer.kind === "unknown") {
      log(`[primary] switch to ${target.name}: the commit got no answer (${answer.error}); this server stays fenced until the other computer is checked`);
      return { ...base, ok: false, outcome: "uncertain", step, error: answer.error, epoch, counts };
    }
    if (!sameCounts(answer.counts, counts)) {
      log(`[primary] switch to ${target.name}: the new primary reports ${JSON.stringify(answer.counts)}, the copy ${JSON.stringify(counts)}`);
      return { ...base, ok: false, outcome: "uncertain", step, error: "the new primary reports different counts", epoch, counts };
    }

    step = "retire";
    // The retired marker before the role: a crash in between still boots fenced and sets the DB aside.
    const retired: RetiredState = { epoch, toMachineId: target.id, toName: target.name, at: now(), pendingSetAside: true };
    writeRetired(deps.appDataDir, retired);
    deps.setFence(retired);
    deps.role.adopt({ primaryMachineId: target.id, epoch });
    rmSync(outgoing, { recursive: true, force: true });
    log(`[primary] handed over to ${target.name} at epoch ${epoch}: ${JSON.stringify(counts)}, ${transcripts.length} transcript files; restarting to set this DB aside`);
    deps.restartSelf();
    return { ...base, ok: true, outcome: "switched", step, epoch, counts, files: files.length, transcripts: transcripts.length, bytes };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Before the commit was sent nothing left this computer for good: undo. During or after it, do not guess.
    if (step === "commit" || step === "retire") {
      log(`[primary] switch to ${target.name} failed at ${step}: ${error}; this server stays fenced`);
      return { ...base, ok: false, outcome: "uncertain", step, error, epoch };
    }
    return undo(error);
  }
}
