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
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, realpathSync, renameSync, rmSync, statSync, writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { LIVE_DB_NAME, RETIRED_DB_NAME } from "./data-dir";
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
export const MOVED_CODE = "primary_moved";
export const DB_NAME = LIVE_DB_NAME;

/**
 * The state folder entries that follow the primary, relative to the state dir.
 * `installation-id` travels with `license-token` because the licence is
 * verified against it, and it lives in the secrets folder (`resolveSecretsDir`),
 * or in the state root on an installation that never moved it there. Nothing
 * else of the secrets folder moves: provider keys reach a primary through its
 * own store, never through this copy.
 */
export const STATE_ENTRIES = ["nodes", "license-token"] as const;
export const INSTALLATION_ID_FILE = "installation-id";

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

/**
 * The state files that follow the primary, already filtered through the
 * receiver's closed list: a file the other side would refuse is never shipped.
 */
export function collectStateFiles(stateDir: string, secretsDir: string): BundleSource[] {
  const state = STATE_ENTRIES.flatMap((entry) => walkFiles(join(stateDir, entry)))
    .map((source) => ({ name: `state/${toBundlePath(relative(stateDir, source))}`, source }));
  const installationId = [join(secretsDir, INSTALLATION_ID_FILE), join(stateDir, INSTALLATION_ID_FILE)].find((p) => existsSync(p));
  const secrets = installationId ? [{ name: `secrets/${INSTALLATION_ID_FILE}`, source: installationId }] : [];
  return [...state, ...secrets].filter((f) => bundleTarget(f.name) !== null);
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

/** Bundle prefix of each attachment kind, and the folder it lands in on the receiver. */
const ATTACHMENT_ROOTS: Record<AttachmentKind, { prefix: string; dir: (d: AttachmentDirs) => string }> = {
  media: { prefix: "media", dir: (d) => join(d.appDataDir, "media") },
  uploads: { prefix: "uploads", dir: (d) => join(d.stateDir, "uploads") },
  views: { prefix: "views", dir: (d) => join(d.dataDir, "views") },
  "kept-transcripts": { prefix: "claude-transcripts", dir: (d) => join(d.dataDir, "claude-transcripts") },
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
  for (const { prefix, dir } of Object.values(ATTACHMENT_ROOTS)) {
    const root = dir(dirs);
    for (const source of walkFiles(root)) {
      if (prefix === "claude-transcripts" && shippedTranscriptIds.has(relative(root, source))) continue;
      out.push({ name: `${prefix}/${toBundlePath(relative(root, source))}`, source });
    }
  }
  return out.filter((f) => bundleTarget(f.name) !== null);
}

type AttachmentKind = "media" | "uploads" | "views" | "kept-transcripts";

/** Where a bundle file lands on the receiver. */
export type BundleTarget =
  | { kind: "db" }
  | { kind: "state" | "secrets" | "transcripts" | AttachmentKind; path: string[] };

const ID = "[A-Za-z0-9_-]{1,128}";
/** One path segment of a transcript folder: no leading dot, so never `.`, `..` or a hidden file. */
const SEGMENT = "[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,200}";
/**
 * The CLOSED list of what a receiver writes, outside its staging folder. Each
 * shape is the exact file one of the writers creates (`nodeTokenPath`,
 * `delegatedNodeTokenPath`, the model token hash, the licence, the
 * installation id) or a transcript under the CLI projects folder. Anything
 * else (code, `.git/hooks`, provider keys, a settings file) has no name here,
 * so it cannot be overwritten by a bundle.
 */
/**
 * One path segment of an attachment: any name a person gave a file (spaces,
 * accents) except a separator, a control character or a leading dot, so never
 * `.`, `..` or a hidden file.
 */
// eslint-disable-next-line no-control-regex -- the control characters are what the class refuses
const FILE_SEGMENT = /[^/\\\x00-\x1f.][^/\\\x00-\x1f]{0,254}/.source;
const BUNDLE_SHAPES: ReadonlyArray<[BundleTarget["kind"], RegExp]> = [
  ["state", new RegExp(`^state/(nodes/${ID}\\.token)$`)],
  ["state", new RegExp(`^state/(nodes/${ID}\\.model-token\\.sha256)$`)],
  ["state", new RegExp(`^state/(nodes/delegated/${ID}/${ID}\\.token)$`)],
  ["state", /^state\/(license-token)$/],
  ["secrets", /^secrets\/(installation-id)$/],
  ["transcripts", new RegExp(`^transcripts/(${SEGMENT}/${ID}\\.jsonl)$`)],
  ["transcripts", new RegExp(`^transcripts/(${SEGMENT}/${ID}(?:/${SEGMENT})+)$`)],
  ["media", new RegExp(`^media/(${FILE_SEGMENT}(?:/${FILE_SEGMENT})*)$`)],
  ["uploads", new RegExp(`^uploads/(${FILE_SEGMENT}(?:/${FILE_SEGMENT})*)$`)],
  ["views", new RegExp(`^views/(${ID}\\.json)$`)],
  ["kept-transcripts", new RegExp(`^claude-transcripts/(${ID}\\.jsonl)$`)],
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
  local: { hostname: string; epoch: number },
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
  now?: () => string;
  log?: (line: string) => void;
}

/**
 * Runs at boot, BEFORE the DB is opened. Two cases, and only one can be pending:
 *
 *  - "restored": a committed bundle waits in `primary-incoming/`. The DB this
 *    server had goes aside, the shipped one takes its place, the state files
 *    and transcripts land where they belong, and `primary-state.json` names
 *    this computer at the new epoch (the file wins over the DB at boot).
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
    const epoch = manifest.epoch;
    // The commit checked the names; they are asked again here, where files are written, before anything moves.
    const refused = manifest.files.find((f) => !bundleTarget(f.name));
    if (refused) throw new Error(`refused bundle name in the manifest: ${refused.name}`);
    mkdirSync(dirname(inputs.dbPath), { recursive: true });
    // A boot that crashed half way runs this again: the staged DB already moved in, so it is not moved twice.
    const stagedDb = stagedPath(inputs.stateDir, DB_NAME);
    const aside = `${inputs.dbPath}.prima-${epoch}`;
    if (existsSync(stagedDb)) {
      setDatabaseAside(inputs.dbPath, epoch);
      // The service DB of an earlier hand-over goes with it: this server is the primary again.
      setDatabaseAside(join(dirname(inputs.dbPath), RETIRED_DB_NAME), epoch);
      renameSync(stagedDb, inputs.dbPath);
    }
    chmodSync(inputs.dbPath, SECRET_FILE_MODE);
    let transcripts = 0;
    let attachments = 0;
    const dataDir = dirname(inputs.dbPath);
    const attachmentDirs = { stateDir: inputs.stateDir, appDataDir: inputs.appDataDir, dataDir };
    const roots: Record<Exclude<BundleTarget["kind"], "db">, string> = {
      state: inputs.stateDir, secrets: inputs.secretsDir, transcripts: inputs.projectsDir,
      media: ATTACHMENT_ROOTS.media.dir(attachmentDirs), uploads: ATTACHMENT_ROOTS.uploads.dir(attachmentDirs),
      views: ATTACHMENT_ROOTS.views.dir(attachmentDirs), "kept-transcripts": ATTACHMENT_ROOTS["kept-transcripts"].dir(attachmentDirs),
    };
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
    writeFileAtomic(join(inputs.appDataDir, PRIMARY_STATE_FILE), JSON.stringify({
      primaryMachineId: manifest.toMachineId, epoch, since: now(),
    }));
    rmSync(join(inputs.appDataDir, RETIRED_FILE), { force: true });
    rmSync(incoming, { recursive: true, force: true });
    log(`[primary] restored the primary from ${manifest.fromMachineId} at epoch ${epoch}: ${JSON.stringify(manifest.counts)}, ${transcripts} transcript files, ${attachments} attachment and view files; the previous DB is ${aside}`);
    return "restored";
  }

  // Staged files no manifest completed: an upload that failed or was abandoned.
  if (existsSync(incoming)) discardIncoming(inputs.stateDir);
  // A whole DB copy a switch left behind when the process died mid-way: no switch runs at boot.
  rmSync(join(inputs.stateDir, OUTGOING_DIR), { recursive: true, force: true });

  const retired = readRetired(inputs.appDataDir);
  if (retired?.phase === "pending-set-aside") {
    const aside = setDatabaseAside(inputs.dbPath, retired.epoch);
    for (const entry of STATE_ENTRIES) setAsideIfPresent(join(inputs.stateDir, entry), retired.epoch);
    // The installation id went with the licence: this server makes a new one of its own.
    for (const dir of [inputs.secretsDir, inputs.stateDir]) setAsideIfPresent(join(dir, INSTALLATION_ID_FILE), retired.epoch);
    writeRetired(inputs.appDataDir, { ...retired, phase: "set-aside" });
    log(`[primary] handed over to ${retired.toMachineId} at epoch ${retired.epoch}: the DB is set aside as ${aside} and this server refuses writes`);
    return "set-aside";
  }
  return null;
}
