/**
 * Moving the primary to another computer, the data half (track T4 of
 * `openspec/changes/nodo-principale-a-mano`).
 *
 * The state moves WHOLE and ONE WAY: the old primary takes a consistent copy of
 * its DB (`VACUUM INTO`, then `PRAGMA integrity_check`), the state folder files
 * a primary needs (node tokens, model token hashes, the licence and the
 * installation id it is bound to) and the CLI transcripts of the topics'
 * sessions, and ships them to the new primary. Two DBs are never merged: the
 * new one starts from the copy, the old one puts its DB aside as
 * `topics.db.prima-<epoch>` and refuses every write from then on.
 *
 * Nothing here swaps a DB under a running server. The receiver stages the files
 * and a manifest, then restarts; `applyPendingPrimaryChange` runs at boot,
 * before the DB is opened, and that is the only place a DB file is moved.
 *
 * The code itself never moves: it lives in git and every machine has its clone.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { LIVE_DB_NAME, RETIRED_DB_NAME } from "./data-dir";
import {
  ID_SEGMENT, INSTANCE_ENTRIES, instanceBaseDir, instanceEntryPath, KEPT_TRANSCRIPTS,
  CONTEXT_FILES, MEDIA, UPLOADS, VIEWS, type InstanceDirs, type InstanceEntry, type InstanceKind,
} from "./instance-files";
import { findCliTranscript } from "./subagent-migration";

/** The tables whose row counts must be identical before and after the move. */
export const SWITCH_TABLES = ["tasks", "messages", "topics"] as const;
export type RowCounts = Record<(typeof SWITCH_TABLES)[number], number>;

/** Under the state dir of the receiver: the staged files and, once committed, the manifest. */
export const INCOMING_DIR = "primary-incoming";
/** Under the state dir of the sender: the snapshot while it is being shipped. */
export const OUTGOING_DIR = "primary-outgoing";
export const MANIFEST_FILE = "manifest.json";
/** Next to `primary-state.json`: present on a server that handed the primary over. */
export const RETIRED_FILE = "primary-retired.json";
export const PRIMARY_STATE_FILE = "primary-state.json";
/** The receiver's answer to "did the restore of epoch N succeed?", read by the sender before it retires. */
export const RESTORE_STATUS_FILE = "primary-restore.json";
export const MOVED_CODE = "primary_moved";
export const DB_NAME = LIVE_DB_NAME;

// The files and folders that follow the primary are listed once, in `instance-files.ts`.

/** Files and folders that carry secrets: owner only, the same modes `writeNodeToken` uses. */
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
  chmodSync(dir, SECRET_DIR_MODE);
}

/**
 * Copies a file and leaves the copy owner-only, whatever mode the source or an
 * old copy had. Folders it creates are owner-only; the existing folders below
 * `root` (the node token folders, when `tightenFolders`) are brought back to
 * owner-only too. `root` itself is never touched: it can be a checkout.
 */
function copyPrivate(from: string, to: string, root: string, tightenFolders: boolean): void {
  mkdirSync(dirname(to), { recursive: true, mode: SECRET_DIR_MODE });
  if (tightenFolders) {
    for (let dir = dirname(to); dir.length > root.length && dir.startsWith(root); dir = dirname(dir)) chmodSync(dir, SECRET_DIR_MODE);
  }
  copyFileSync(from, to);
  chmodSync(to, SECRET_FILE_MODE);
}

/** `mtimeMs` is the modification time on the sender: what decides between two transcripts that diverged. */
export interface ManifestFile { name: string; size: number; sha256: string; mtimeMs?: number }

export interface SwitchManifest {
  version: 1;
  epoch: number;
  toMachineId: string;
  toHostname: string;
  fromMachineId: string;
  createdAt: string;
  counts: RowCounts;
  files: ManifestFile[];
  /**
   * SHA-256 of a one-time secret only the sender holds. After the restore the
   * receiver runs on the sender's DB, where the sender's node credential does
   * not exist: the secret is how the sender asks "are you the primary now?".
   */
  confirmSha256?: string;
}

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

export function countRows(db: Pick<Database, "query">): RowCounts {
  const out = {} as RowCounts;
  for (const table of SWITCH_TABLES) {
    out[table] = (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return out;
}

export function sameCounts(a: RowCounts, b: RowCounts): boolean {
  return SWITCH_TABLES.every((t) => a[t] === b[t]);
}

/** Opens a DB file read-only, throws unless `integrity_check` says ok, returns its counts. */
export function verifyDatabaseFile(path: string): RowCounts {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(`integrity_check failed on ${path}: ${rows.slice(0, 3).map((r) => r.integrity_check).join("; ")}`);
    }
    return countRows(db);
  } finally {
    db.close();
  }
}

/**
 * A consistent single-file copy of a live DB (WAL included), verified. `VACUUM
 * INTO` rather than the online backup API: one statement, one file, the same
 * transactional snapshot. The copy holds every secret the DB holds, so it is
 * owner-only from the first byte to the last.
 */
export function snapshotDatabase(db: Pick<Database, "query">, dest: string): RowCounts {
  ensurePrivateDir(dirname(dest));
  rmSync(dest, { force: true });
  // VACUUM INTO refuses an existing file, so the owner-only mode comes from the umask while it
  // creates one. The statement is synchronous: no other code of this process runs in between.
  const previousMask = process.umask(0o077);
  try {
    db.query("VACUUM INTO ?").run(dest);
  } finally {
    process.umask(previousMask);
  }
  chmodSync(dest, SECRET_FILE_MODE);
  return verifyDatabaseFile(dest);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

/** A file to ship: its name in the bundle and where it is read from on the sender. */
export interface BundleSource { name: string; source: string }

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

const toBundlePath = (p: string) => p.split(sep).join("/");

/** Every folder the files of an instance live under, as the `data-dir.ts` resolvers answer them. */
export type StateDirs = InstanceDirs & { stateDir: string; secretsDir: string; appDataDir: string };

/**
 * The instance files that are not attachments (node tokens, licence, the
 * installation id, topic memory, VAPID keys, ...), read off the list of
 * `instance-files.ts` and already filtered through the receiver's closed list:
 * a file the other side would refuse is never shipped.
 */
export function collectStateFiles(dirs: StateDirs): BundleSource[] {
  const out: BundleSource[] = [];
  for (const entry of INSTANCE_ENTRIES) {
    if (entry.kind in ATTACHMENT_ROOTS) continue;
    // A file lives in one place: the first root that has it wins (the installation id of an old state root).
    const roots = [entry, ...(entry.fallbackRoot ? [{ ...entry, root: entry.fallbackRoot }] : [])].map((e) => instanceBaseDir(e, dirs));
    const base = roots.find((r) => existsSync(join(r, entry.path)));
    if (base === undefined) continue;
    for (const source of walkFiles(join(base, entry.path))) out.push({ name: `${entry.prefix}/${toBundlePath(relative(base, source))}`, source });
  }
  return out.filter((f) => bundleTarget(f.name) !== null);
}

/**
 * The CLI transcripts of every session bound to a topic, with the folder of the
 * session's subagents when there is one. They keep their project folder name:
 * the CLI resumes a session by id from any folder.
 */
export function collectTranscripts(db: Pick<Database, "query">, projectsDir: string): BundleSource[] {
  const rows = db.query(
    `SELECT DISTINCT s.claude_session_id AS csid FROM claude_code_sessions s
       JOIN topics t ON t.session_key = s.session_key
      WHERE s.claude_session_id IS NOT NULL`,
  ).all() as Array<{ csid: string }>;
  const out: BundleSource[] = [];
  for (const { csid } of rows) {
    const file = findCliTranscript(csid, projectsDir);
    if (!file) continue;
    const sessionDir = join(dirname(file), csid);
    for (const source of [file, ...walkFiles(sessionDir)]) {
      out.push({ name: `transcripts/${toBundlePath(relative(projectsDir, source))}`, source });
    }
  }
  // A file whose name the receiver's closed list refuses would stop the whole switch: it stays behind.
  return out.filter((f) => bundleTarget(f.name) !== null);
}

/** The folders of the sender that hold what chats and views point at, besides the DB. */
export interface AttachmentDirs {
  stateDir: string;
  appDataDir: string;
  /** The data folder inside the state root (`resolveDataDir`): where `views/` and `claude-transcripts/` live. */
  dataDir: string;
}

/** The attachment entries by kind: bundle prefix and the folder each one lands in on the receiver. */
const ATTACHMENT_ROOTS: Partial<Record<InstanceKind, InstanceEntry>> = {
  media: MEDIA, uploads: UPLOADS, "context-files": CONTEXT_FILES, views: VIEWS, "kept-transcripts": KEPT_TRANSCRIPTS,
};

/**
 * What a chat or a view points at and the DB does not hold: the files of the
 * media folder (attachments, task previews), the uploads, the stored views, and
 * the keeper's copies of the CLI transcripts (`lib/transcript-keeper.ts`: the
 * only copy of a session whose CLI file the CLI's own cleanup removed). A
 * keeper copy of a transcript already shipped by `collectTranscripts` is the
 * same file under a second name, so it stays out of the bundle. Symbolic links
 * are never followed (`walkFiles` lists regular files only), and a name the
 * receiver's closed list refuses stays behind, like for the other kinds.
 */
export function collectAttachmentFiles(dirs: AttachmentDirs, shipped: readonly BundleSource[] = []): BundleSource[] {
  const shippedTranscriptIds = new Set(shipped.filter((f) => f.name.startsWith("transcripts/")).map((f) => f.name.split("/").pop()));
  const out: BundleSource[] = [];
  for (const entry of Object.values(ATTACHMENT_ROOTS)) {
    const { prefix } = entry;
    const root = instanceEntryPath(entry, dirs);
    for (const source of walkFiles(root)) {
      if (prefix === "claude-transcripts" && shippedTranscriptIds.has(relative(root, source))) continue;
      out.push({ name: `${prefix}/${toBundlePath(relative(root, source))}`, source });
    }
  }
  return out.filter((f) => bundleTarget(f.name) !== null);
}

/** Where a bundle file lands on the receiver. */
export type BundleTarget =
  | { kind: "db" }
  | { kind: InstanceKind | "transcripts"; path: string[] };

/** One path segment of a transcript folder: no leading dot, so never `.`, `..` or a hidden file. */
const SEGMENT = "[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,200}";
/**
 * The CLOSED list of what a receiver writes, outside its staging folder: the
 * `accept` shapes of every entry of `instance-files.ts` (each is the exact
 * file one of the writers creates, or a file below an attachment folder) and
 * the transcripts under the CLI projects folder. Anything else (code,
 * `.git/hooks`, provider keys, a settings file) has no name here, so it cannot
 * be overwritten by a bundle.
 */
const BUNDLE_SHAPES: ReadonlyArray<[BundleTarget["kind"], RegExp]> = [
  ...INSTANCE_ENTRIES.flatMap((e) => e.accept.map((a): [BundleTarget["kind"], RegExp] => [e.kind, new RegExp(`^${e.prefix}/(${a})$`)])),
  ["transcripts", new RegExp(`^transcripts/(${SEGMENT}/${ID_SEGMENT}\\.jsonl)$`)],
  ["transcripts", new RegExp(`^transcripts/(${SEGMENT}/${ID_SEGMENT}(?:/${SEGMENT})+)$`)],
];

export function bundleTarget(name: string): BundleTarget | null {
  if (name === DB_NAME) return { kind: "db" };
  for (const [kind, shape] of BUNDLE_SHAPES) {
    const m = shape.exec(name);
    if (m?.[1]) return { kind, path: m[1].split("/") } as BundleTarget;
  }
  return null;
}

/** A name the receiver accepts: one of the closed shapes of `bundleTarget`. */
export function isSafeBundleName(name: string): boolean {
  return bundleTarget(name) !== null;
}

/**
 * Forgets whatever is staged and not committed. A new switch begins with the
 * DB at offset 0, and the boot drops a staging folder no manifest completed:
 * an upload that failed half way never sits on disk with its secrets.
 */
export function discardIncoming(stateDir: string): void {
  rmSync(join(stateDir, INCOMING_DIR), { recursive: true, force: true });
}

/** Where a staged file lives on the receiver. */
function stagedPath(stateDir: string, name: string): string {
  return join(stateDir, INCOMING_DIR, ...name.split("/"));
}

/**
 * Appends one chunk of a file being staged. The offset must equal what is
 * already there: a chunk that arrives twice or out of order is refused, never
 * written over what came before. Offset 0 starts the file again.
 */
export function writeIncomingChunk(stateDir: string, name: string, offset: number, bytes: Uint8Array): number {
  if (!isSafeBundleName(name)) throw new Error(`refused bundle name: ${name}`);
  // The DB is always the first file of a switch: its first chunk starts from a clean staging folder.
  if (name === DB_NAME && offset === 0) discardIncoming(stateDir);
  const path = stagedPath(stateDir, name);
  ensurePrivateDir(join(stateDir, INCOMING_DIR));
  ensurePrivateDir(dirname(path));
  if (offset === 0) rmSync(path, { force: true });
  const have = existsSync(path) ? statSync(path).size : 0;
  if (offset !== have) throw new Error(`chunk at ${offset} for ${name}, but ${have} bytes are staged`);
  const fd = openSync(path, "a", SECRET_FILE_MODE);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return have + bytes.byteLength;
}

/**
 * Room kept free on top of the copies the restore makes: the new DB grows (its
 * WAL, the first writes of the new primary) and the receiver must not boot onto
 * a full disk.
 */
export const SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

/** Free bytes for an unprivileged writer on the volume holding `dir`. */
export function freeBytesOf(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * What the restore needs on top of what is already staged. The DB is renamed
 * into place and costs nothing more; every other file is COPIED out of the
 * staging folder (`copyPrivate`), so it exists twice until the boot drops the
 * staging folder.
 */
export function restoreSpaceNeeded(files: readonly ManifestFile[]): number {
  return files.filter((f) => f.name !== DB_NAME).reduce((sum, f) => sum + f.size, 0) + SPACE_MARGIN_BYTES;
}

export type CommitVerdict = { ok: true; counts: RowCounts } | { ok: false; code: string; error: string };

/**
 * The receiver's commit: every staged file matches its size and hash, the DB
 * passes `integrity_check` with the declared counts, the manifest names this
 * computer and an epoch above ours. Only then the manifest is written next to
 * the files, which is what the next boot reads as "restore this".
 */
export async function commitIncoming(
  stateDir: string,
  manifest: SwitchManifest,
  local: {
    hostname: string;
    epoch: number;
    /** Free bytes on the volume of `dir`; the real `statfs` unless a test says otherwise. */
    freeBytes?: (dir: string) => number;
    /** The checks of this computer's own folders and replica; the receiving route always passes them. */
    receive?: ReceiveChecks;
  },
): Promise<CommitVerdict> {
  if (manifest?.version !== 1 || !Array.isArray(manifest.files)) return { ok: false, code: "invalid_manifest", error: "unreadable manifest" };
  if (manifest.toHostname !== local.hostname) {
    return { ok: false, code: "wrong_machine", error: `the manifest is for ${manifest.toHostname}, this is ${local.hostname}` };
  }
  if (!Number.isInteger(manifest.epoch) || manifest.epoch <= local.epoch) {
    return { ok: false, code: "stale_epoch", error: `epoch ${manifest.epoch} is not above this server's ${local.epoch}` };
  }
  if (!manifest.files.some((f) => f.name === DB_NAME)) return { ok: false, code: "invalid_manifest", error: "the manifest carries no DB" };
  for (const f of manifest.files) {
    if (!isSafeBundleName(f.name)) return { ok: false, code: "invalid_manifest", error: `refused bundle name: ${f.name}` };
  }
  // Before the commit, so a refusal changes nothing: a restore that runs out of space half way is the one that hurts.
  const needed = restoreSpaceNeeded(manifest.files);
  let free: number;
  try {
    free = (local.freeBytes ?? freeBytesOf)(stateDir);
  } catch {
    // No answer from the OS is not a reason to refuse a switch that may well fit.
    free = Number.POSITIVE_INFINITY;
  }
  if (free < needed) return { ok: false, code: "no_space", error: `the restore needs ${needed} free bytes, this computer has ${free}` };
  if (local.receive) {
    const refused = receiverRefusal(stateDir, manifest, local.receive, local.freeBytes ?? freeBytesOf);
    if (refused) return { ok: false, ...refused };
  }
  for (const f of manifest.files) {
    const path = stagedPath(stateDir, f.name);
    if (!existsSync(path) || statSync(path).size !== f.size) return { ok: false, code: "incomplete", error: `${f.name} is missing or short` };
    if ((await sha256File(path)) !== f.sha256) return { ok: false, code: "hash_mismatch", error: `${f.name} does not match its hash` };
  }
  let counts: RowCounts;
  try {
    counts = verifyDatabaseFile(stagedPath(stateDir, DB_NAME));
  } catch (err) {
    return { ok: false, code: "integrity", error: err instanceof Error ? err.message : String(err) };
  }
  if (!sameCounts(counts, manifest.counts)) {
    return { ok: false, code: "count_mismatch", error: `counts ${JSON.stringify(counts)} differ from the declared ${JSON.stringify(manifest.counts)}` };
  }
  writeFileAtomic(join(stateDir, INCOMING_DIR, MANIFEST_FILE), JSON.stringify(manifest));
  if (local.receive) {
    const now = local.receive.now ?? (() => new Date().toISOString());
    writeRestoreStatus(local.receive.appDataDir, { epoch: manifest.epoch, confirmSha256: manifest.confirmSha256!, state: "committed" }, now);
  }
  return { ok: true, counts };
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

function writeRestoreStatus(appDataDir: string, status: Omit<RestoreStatus, "at">, now: () => string): void {
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

/** Process ids holding `path` open, by `lsof`. None where `lsof` is missing: then only the Litestream folder is looked for. */
function lsofHolders(path: string): number[] {
  if (process.platform === "win32" || !existsSync(path)) return [];
  const r = spawnSync("lsof", ["-t", "--", path], { encoding: "utf-8", timeout: 10_000 });
  if (r.error || typeof r.stdout !== "string") return [];
  return r.stdout.split(/\s+/).filter(Boolean).map(Number).filter((pid) => Number.isInteger(pid));
}

/**
 * Why the live DB looks replicated (a Litestream folder next to it, another
 * process holding it open), or null. Replacing the file under such a process
 * corrupts what it publishes, so the swap needs the replica stop and start commands.
 */
export function replicaWatching(dbPath: string, holdersOf: (path: string) => number[] = lsofHolders): string | null {
  const sidecar = join(dirname(dbPath), `.${basename(dbPath)}-litestream`);
  if (existsSync(sidecar)) return `a Litestream folder (${basename(sidecar)}) sits next to the DB`;
  return heldBy(dbPath, holdersOf);
}

/**
 * Why another process holds the live DB open, or null. Asked again after the
 * replica stop and right before the rename: a stop that only kills a Litestream
 * under a supervisor that restarts it (launchd KeepAlive, systemd Restart=)
 * exits 0 while a new one already holds the file. The Litestream folder is not
 * asked here, a stopped replica leaves it in place.
 */
function heldBy(dbPath: string, holdersOf: (path: string) => number[] = lsofHolders): string | null {
  const pids = holdersOf(dbPath).filter((pid) => pid !== process.pid);
  return pids.length > 0 ? `process ${pids.join(", ")} holds the DB open` : null;
}

function refuseIfHeld(dbPath: string, holdersOf: ((path: string) => number[]) | undefined, when: string): void {
  const held = heldBy(dbPath, holdersOf);
  if (held) throw new Error(`${held} ${when}: a supervisor may have started the replica again (stop it through the service manager, not with a kill), so the DB is not replaced under it`);
}

/** Writes and removes a probe file in `dir`: the error message when this server cannot write there, else null. */
function unwritable(dir: string): string | null {
  const probe = join(dir, `.topics-write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The folders of this computer a restore writes into, and its replica: what the receiver checks before it agrees. */
export interface ReceiveChecks {
  secretsDir: string;
  appDataDir: string;
  dbPath: string;
  projectsDir: string;
  replica: ReplicaCommands;
  /** Process ids holding a file open; `lsof` unless a test says otherwise. */
  holdersOf?: (path: string) => number[];
  now?: () => string;
}

type RestoreRoots = Record<Exclude<BundleTarget["kind"], "db">, string>;

/** The folder each kind of bundle file is restored into. */
function restoreRoots(dirs: { stateDir: string; secretsDir: string; appDataDir: string; dbPath: string; projectsDir: string }): RestoreRoots {
  const instance = { stateDir: dirs.stateDir, secretsDir: dirs.secretsDir, appDataDir: dirs.appDataDir, dataDir: dirname(dirs.dbPath) };
  return Object.fromEntries(
    [...INSTANCE_ENTRIES.map((e): [string, string] => [e.kind, instanceBaseDir(e, instance)]), ["transcripts", dirs.projectsDir]],
  ) as RestoreRoots;
}

/**
 * What the receiver checks on its own disk before it agrees, so a commit it
 * gives is one its boot can carry out: a replica it can stop, folders it can
 * write, room on every volume it writes to. A refusal here changes nothing and
 * the sender stays the primary.
 */
function receiverRefusal(
  stateDir: string, manifest: SwitchManifest, r: ReceiveChecks, freeBytes: (dir: string) => number,
): { code: string; error: string } | null {
  if (!/^[0-9a-f]{64}$/.test(manifest.confirmSha256 ?? "")) return { code: "invalid_manifest", error: "the manifest carries no confirmation hash" };
  const watched = replicaWatching(r.dbPath, r.holdersOf);
  if (watched && (!r.replica.stop || !r.replica.start)) {
    return { code: "replica_unmanaged", error: `${watched}, and ${REPLICA_STOP_ENV} and ${REPLICA_START_ENV} are not both set: replacing the DB under it would corrupt the replica` };
  }
  const roots = restoreRoots({ stateDir, ...r });
  const bytesByDir = new Map<string, number>([[dirname(r.dbPath), 0], [r.appDataDir, 0]]);
  for (const f of manifest.files) {
    const target = bundleTarget(f.name);
    if (!target || target.kind === "db") continue;
    const dir = roots[target.kind];
    bytesByDir.set(dir, (bytesByDir.get(dir) ?? 0) + f.size);
  }
  for (const [dir, bytes] of bytesByDir) {
    const why = unwritable(dir);
    if (why) return { code: "not_writable", error: `the restore writes into ${dir}, which this server cannot write: ${why}` };
    let free: number;
    try { free = freeBytes(dir); } catch { free = Number.POSITIVE_INFINITY; }
    if (free < bytes + SPACE_MARGIN_BYTES) return { code: "no_space", error: `the restore writes ${bytes} bytes into ${dir}, whose volume has ${free} free` };
  }
  return null;
}

/**
 * A request a fenced server refuses. Until its DB is set aside: every write,
 * whatever the path (a device revoked or a share link removed here after the
 * snapshot would be lost on the new primary), and every WebSocket upgrade (a
 * socket carries writes too). Once set aside the server runs on an empty DB:
 * the node and pairing routes open again, they are how it becomes a node.
 * The loopback `/__daemon/` endpoints answer before this check.
 */
export function isRefusedWhenRetired(pathname: string, method: string, phase: RetiredPhase): boolean {
  const m = method.toUpperCase();
  const ws = pathname === "/ws" || pathname.startsWith("/ws/");
  if ((m === "GET" || m === "HEAD" || m === "OPTIONS") && !ws) return false;
  if (phase !== "set-aside") return true;
  if (!pathname.startsWith("/api/") && !ws) return false;
  return !pathname.startsWith("/api/nodes/") && !pathname.startsWith("/api/auth/");
}

export function movedResponse(retired: Pick<RetiredState, "epoch" | "toMachineId" | "toName">): Response {
  return new Response(JSON.stringify({
    code: MOVED_CODE,
    error: "This computer is no longer the primary: write to the new one",
    epoch: retired.epoch,
    primaryMachineId: retired.toMachineId,
    primaryName: retired.toName,
  }), { status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const DB_SIDE_FILES = ["", "-wal", "-shm"];

/** A DB file (and its WAL and shared memory) renamed to `<name>.prima-<epoch>`. */
function setDatabaseAside(dbPath: string, epoch: number): string {
  // The WAL and shared memory follow the DB name, so the copy set aside still opens with its last writes.
  const aside = `${dbPath}.prima-${epoch}`;
  for (const suffix of DB_SIDE_FILES) setAsideIfPresent(dbPath + suffix, epoch);
  return aside;
}

/** How the shipped file and the one already on this computer relate, byte by byte. */
type Overlap = "same" | "incoming-is-prefix" | "existing-is-prefix" | "diverged";

/** Compares two files from the start in chunks: transcripts can be hundreds of MB, never read whole. */
function compareFiles(incoming: string, existing: string): Overlap {
  const sizeIn = statSync(incoming).size;
  const sizeEx = statSync(existing).size;
  const common = Math.min(sizeIn, sizeEx);
  const a = Buffer.allocUnsafe(1 << 20);
  const b = Buffer.allocUnsafe(1 << 20);
  const fdIn = openSync(incoming, "r");
  const fdEx = openSync(existing, "r");
  try {
    for (let offset = 0; offset < common; offset += a.length) {
      const length = Math.min(a.length, common - offset);
      readSync(fdIn, a, 0, length, offset);
      readSync(fdEx, b, 0, length, offset);
      if (!a.subarray(0, length).equals(b.subarray(0, length))) return "diverged";
    }
  } finally {
    closeSync(fdIn);
    closeSync(fdEx);
  }
  if (sizeIn === sizeEx) return "same";
  return sizeIn < sizeEx ? "incoming-is-prefix" : "existing-is-prefix";
}

/**
 * True when `to` (or the folders above it) would write outside `root` through a
 * symbolic link: the receiver never follows one out of the folder it restores into.
 */
function escapesRoot(to: string, root: string): boolean {
  try {
    if (existsSync(to) && lstatSync(to).isSymbolicLink()) return true;
    let nearest = dirname(to);
    while (!existsSync(nearest)) nearest = dirname(nearest);
    // The root itself does not exist yet: nothing below it can be a link.
    if (!existsSync(root)) return false;
    return !(realpathSync(nearest) + sep).startsWith(realpathSync(root) + sep);
  } catch {
    return true;
  }
}

/** The JSONL of the CLI only ever grows: that is what lets two copies of one session be compared. */
const APPEND_ONLY_KINDS: ReadonlySet<BundleTarget["kind"]> = new Set(["transcripts", "kept-transcripts"]);

type Placed = "placed" | "kept" | "unchanged" | "refused";

/**
 * Puts one shipped file where it belongs without losing what is already there.
 *
 *  - nothing there, or the very same bytes: copied, or left alone;
 *  - a transcript (append-only): the longer one wins when one is the start of
 *    the other, so the session never goes back in time; two that diverged
 *    (the session was resumed on both computers) go to the more recent one by
 *    modification time, and the other is kept next to it as `.prima-<epoch>`;
 *  - any other file: the shipped one takes the name, the one that was there is
 *    renamed aside.
 */
function placeShipped(from: string, to: string, root: string, opts: { kind: BundleTarget["kind"]; epoch: number; shippedMtimeMs: number; tightenFolders: boolean }): Placed {
  if (!existsSync(to)) {
    copyPrivate(from, to, root, opts.tightenFolders);
    return "placed";
  }
  const overlap = compareFiles(from, to);
  if (overlap === "same") return "unchanged";
  if (APPEND_ONLY_KINDS.has(opts.kind)) {
    if (overlap === "incoming-is-prefix") return "kept";
    if (overlap === "diverged" && statSync(to).mtimeMs >= opts.shippedMtimeMs) {
      const aside = `${to}.prima-${opts.epoch}`;
      if (!existsSync(aside)) copyPrivate(from, aside, root, opts.tightenFolders);
      return "kept";
    }
  }
  setAsideIfPresent(to, opts.epoch);
  copyPrivate(from, to, root, opts.tightenFolders);
  return "placed";
}

/** Renames a path aside once: a boot that runs again after a crash never overwrites the first copy set aside. */
function setAsideIfPresent(path: string, epoch: number): void {
  const aside = `${path}.prima-${epoch}`;
  if (existsSync(path) && !existsSync(aside)) renameSync(path, aside);
}

export interface PendingChangeInputs {
  stateDir: string;
  secretsDir: string;
  dbPath: string;
  appDataDir: string;
  projectsDir: string;
  /** Shell command lines that stop and start the replica of the live DB around its replacement. Empty or absent: no replica is managed. */
  replica?: ReplicaCommands;
  /** Process ids holding a file open; `lsof` unless a test says otherwise. */
  holdersOf?: (path: string) => number[];
  now?: () => string;
  log?: (line: string) => void;
}

export interface ReplicaCommands { stop?: string; start?: string }

/** Instance settings, read from the environment: a command line each, default empty (no replica managed). */
export const REPLICA_STOP_ENV = "TOPICS_REPLICA_STOP_COMMAND";
export const REPLICA_START_ENV = "TOPICS_REPLICA_START_COMMAND";

export function replicaCommandsFromEnv(env: NodeJS.ProcessEnv = process.env): ReplicaCommands {
  return { stop: env[REPLICA_STOP_ENV]?.trim() || undefined, start: env[REPLICA_START_ENV]?.trim() || undefined };
}

/**
 * Runs one configured replica command through the shell (no arguments of ours,
 * so nothing secret is on a command line), logs how it ended and returns why it
 * failed, or null. A command that runs past the timeout counts as failed.
 */
function runReplicaCommand(what: "stop" | "start", command: string, log: (line: string) => void): string | null {
  const shell = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
  let failure: string | null;
  try {
    // stdio ignored: a replica started in the background must not keep a pipe of ours open.
    const r = spawnSync(shell[0]!, shell.slice(1), { stdio: "ignore", timeout: REPLICA_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
    failure = r.status === 0 && !r.error ? null : (r.error?.message ?? `exit ${r.status}, signal ${r.signal}`);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  log(`[primary] replica ${what} command ${failure ? `failed (${failure})` : "ok"}`);
  return failure;
}

const REPLICA_COMMAND_TIMEOUT_MS = 60_000;

/**
 * The restore of one committed bundle. The replica of the live DB is stopped
 * FIRST, before anything moves: a stop that fails or hangs throws with this
 * computer untouched, because a DB replaced under a running Litestream is a
 * corrupt replica. A replica found without the commands to stop it is the same
 * refusal (the commit refuses it too; this is the boot asking again). The start
 * runs whatever happens after the stop; when it fails the restore still stands
 * and the reason comes back as the warning the sender reports.
 */
function restoreBundle(inputs: PendingChangeInputs, manifest: SwitchManifest, log: (line: string) => void, now: () => string): string | undefined {
  const incoming = join(inputs.stateDir, INCOMING_DIR);
  const epoch = manifest.epoch;
  // The commit checked the names; they are asked again here, where files are written, before anything moves.
  const refused = manifest.files.find((f) => !bundleTarget(f.name));
  if (refused) throw new Error(`refused bundle name in the manifest: ${refused.name}`);
  mkdirSync(dirname(inputs.dbPath), { recursive: true });
  const stagedDb = stagedPath(inputs.stateDir, DB_NAME);
  const swapping = existsSync(stagedDb);
  const { stop, start } = inputs.replica ?? {};
  if (swapping) {
    const watched = replicaWatching(inputs.dbPath, inputs.holdersOf);
    if (watched && (!stop || !start)) throw new Error(`${watched} and the replica commands are not both set: the DB is not replaced under it`);
    const failed = stop ? runReplicaCommand("stop", stop, log) : null;
    if (failed) throw new Error(`the replica did not stop (${failed}): the DB is not replaced under it`);
  }
  let warning: string | undefined;
  let transcripts = 0;
  let attachments = 0;
  const roots = restoreRoots(inputs);
  const aside = `${inputs.dbPath}.prima-${epoch}`;
  try {
    // Nothing has moved yet: a replica already back on the DB stops the restore here.
    if (swapping && stop) refuseIfHeld(inputs.dbPath, inputs.holdersOf, "after the replica stop command");
    // The files go BEFORE the DB and the role file. A copy that fails (no permission, no space) throws
    // here with the DB still the receiver's own and no `primary-state.json` written: the manifest stays
    // staged and the receiver never runs as a primary without its files.
    // A boot that crashed half way runs this again: files already in place are the same bytes and stay.
    for (const f of manifest.files) {
      const target = bundleTarget(f.name)!;
      if (target.kind === "db") continue;
      const from = stagedPath(inputs.stateDir, f.name);
      const to = join(roots[target.kind], ...target.path);
      if (target.kind === "transcripts") transcripts++;
      const isAttachment = target.kind in ATTACHMENT_ROOTS;
      if (isAttachment) {
        // A link inside the folder that points out of it: the file stays staged and is dropped with the rest.
        if (escapesRoot(to, roots[target.kind])) { log(`[primary] ${f.name} not restored: it would be written through a symbolic link`); continue; }
        attachments++;
      }
      if (target.kind === "secrets") ensurePrivateDir(inputs.secretsDir);
      placeShipped(from, to, roots[target.kind], {
        kind: target.kind, epoch, shippedMtimeMs: f.mtimeMs ?? statSync(from).mtimeMs, tightenFolders: target.kind === "state",
      });
    }
    if (swapping) {
      if (stop) refuseIfHeld(inputs.dbPath, inputs.holdersOf, "right before the DB is replaced");
      setDatabaseAside(inputs.dbPath, epoch);
      // The service DB of an earlier hand-over goes with it: this server is the primary again.
      setDatabaseAside(join(dirname(inputs.dbPath), RETIRED_DB_NAME), epoch);
      renameSync(stagedDb, inputs.dbPath);
    }
  } finally {
    if (swapping && start) {
      const failed = runReplicaCommand("start", start, log);
      if (failed) warning = `the replica of the DB did not start again (${failed}): this primary runs without it until it is started by hand`;
    }
  }
  chmodSync(inputs.dbPath, SECRET_FILE_MODE);
  writeFileAtomic(join(inputs.appDataDir, PRIMARY_STATE_FILE), JSON.stringify({
    primaryMachineId: manifest.toMachineId, epoch, since: now(),
  }));
  rmSync(join(inputs.appDataDir, RETIRED_FILE), { force: true });
  rmSync(incoming, { recursive: true, force: true });
  log(`[primary] restored the primary from ${manifest.fromMachineId} at epoch ${epoch}: ${JSON.stringify(manifest.counts)}, ${transcripts} transcript files, ${attachments} attachment and view files; the previous DB is ${aside}`);
  if (warning) log(`[primary] ${warning}`);
  return warning;
}

/**
 * Runs at boot, BEFORE the DB is opened. Two cases, and only one can be pending:
 *
 *  - "restored": a committed bundle waits in `primary-incoming/`. The DB this
 *    server had goes aside, the shipped one takes its place, the state files
 *    and transcripts land where they belong, and `primary-state.json` names
 *    this computer at the new epoch (the file wins over the DB at boot). The
 *    outcome, restored or failed, is written for the sender that waits on it
 *    (`RESTORE_STATUS_FILE`).
 *  - "set-aside": this server handed the primary over. Its DB and the state
 *    entries that moved are renamed aside, so it starts on a service DB under
 *    another name as a secondary and never writes into the data it gave away.
 *    No file exists at the old DB path from then on: Litestream or any other
 *    replica of that path has nothing new to publish, and a restore "from the
 *    latest" still returns the data that was handed over.
 */
export function applyPendingPrimaryChange(inputs: PendingChangeInputs): "restored" | "set-aside" | null {
  const now = inputs.now ?? (() => new Date().toISOString());
  const log = inputs.log ?? ((line: string) => console.warn(line));
  const incoming = join(inputs.stateDir, INCOMING_DIR);
  const manifestPath = join(incoming, MANIFEST_FILE);

  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as SwitchManifest;
    // A manifest of a sender that waits on the outcome: it learns it from this file, never from a guess.
    const status = manifest.confirmSha256 ? { epoch: manifest.epoch, confirmSha256: manifest.confirmSha256 } : null;
    try {
      const warning = restoreBundle(inputs, manifest, log, now);
      if (status) writeRestoreStatus(inputs.appDataDir, { ...status, state: "restored", ...(warning ? { warning } : {}) }, now);
      return "restored";
    } catch (err) {
      if (status) writeRestoreStatus(inputs.appDataDir, { ...status, state: "failed", error: err instanceof Error ? err.message : String(err) }, now);
      throw err;
    }
  }

  // Staged files no manifest completed: an upload that failed or was abandoned.
  if (existsSync(incoming)) discardIncoming(inputs.stateDir);
  // A whole DB copy a switch left behind when the process died mid-way: no switch runs at boot.
  rmSync(join(inputs.stateDir, OUTGOING_DIR), { recursive: true, force: true });

  const retired = readRetired(inputs.appDataDir);
  if (retired?.phase === "pending-set-aside") {
    const aside = setDatabaseAside(inputs.dbPath, retired.epoch);
    // Everything of the instance list that moved (tokens, licence, memory, VAPID keys, ...) goes aside too.
    // The installation id went with the licence: this server makes a new one of its own.
    const dirs = { stateDir: inputs.stateDir, secretsDir: inputs.secretsDir, appDataDir: inputs.appDataDir, dataDir: dirname(inputs.dbPath) };
    for (const entry of INSTANCE_ENTRIES) {
      if (entry.kind in ATTACHMENT_ROOTS) continue;
      for (const root of [entry, ...(entry.fallbackRoot ? [{ ...entry, root: entry.fallbackRoot }] : [])]) setAsideIfPresent(instanceEntryPath(root, dirs), retired.epoch);
    }
    writeRetired(inputs.appDataDir, { ...retired, phase: "set-aside" });
    log(`[primary] handed over to ${retired.toMachineId} at epoch ${retired.epoch}: the DB is set aside as ${aside} and this server refuses writes`);
    return "set-aside";
  }
  return null;
}
