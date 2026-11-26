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
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { writeFileAtomic } from "./atomic-write";
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
export const DB_NAME = "topics.db";

/**
 * The state folder entries that follow the primary, relative to the state dir.
 * `installation-id` travels with `license-token` because the licence is
 * verified against it. Provider keys (`.topics-secrets`) stay where they are:
 * secrets reach a primary through its own store, never through this copy.
 */
export const STATE_ENTRIES = ["nodes", "license-token", "installation-id"] as const;

export interface ManifestFile { name: string; size: number; sha256: string }

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

export interface RetiredState {
  epoch: number;
  toMachineId: string;
  toName: string | null;
  at: string;
  /** True until the boot that moves this server's DB and state aside has run. */
  pendingSetAside: boolean;
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

/** A consistent single-file copy of a live DB (WAL included), verified. */
export function snapshotDatabase(db: Pick<Database, "query">, dest: string): RowCounts {
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  db.query("VACUUM INTO ?").run(dest);
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

export function collectStateFiles(stateDir: string): BundleSource[] {
  return STATE_ENTRIES.flatMap((entry) => walkFiles(join(stateDir, entry)))
    .map((source) => ({ name: `state/${toBundlePath(relative(stateDir, source))}`, source }));
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
  return out;
}

/**
 * A name the receiver accepts: the DB, or a file under `state/` or
 * `transcripts/`, with no empty, `.` or `..` segment and nothing absolute.
 */
export function isSafeBundleName(name: string): boolean {
  if (name === DB_NAME) return true;
  if (!/^(state|transcripts)\/[A-Za-z0-9._@+/-]+$/.test(name)) return false;
  const segments = name.split("/");
  return segments.length >= 2 && segments.every((s) => s !== "" && s !== "." && s !== "..");
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
  const path = stagedPath(stateDir, name);
  mkdirSync(dirname(path), { recursive: true });
  if (offset === 0) rmSync(path, { force: true });
  const have = existsSync(path) ? statSync(path).size : 0;
  if (offset !== have) throw new Error(`chunk at ${offset} for ${name}, but ${have} bytes are staged`);
  const fd = openSync(path, "a");
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
    return {
      epoch: raw.epoch as number,
      toMachineId: raw.toMachineId,
      toName: typeof raw.toName === "string" ? raw.toName : null,
      at: typeof raw.at === "string" ? raw.at : "",
      pendingSetAside: raw.pendingSetAside === true,
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
 * A write a retired server refuses: any mutating `/api/` call, except the node
 * routes (already fenced by the epoch, and how a new primary reaches this
 * machine again) and the pairing ones (how this machine becomes a node).
 */
export function isRefusedWhenRetired(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  if (!pathname.startsWith("/api/")) return false;
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

/** `topics.db` (and its WAL and shared memory) renamed to `topics.db.prima-<epoch>`. */
function setDatabaseAside(dbPath: string, epoch: number): string {
  // The WAL and shared memory follow the DB name, so the copy set aside still opens with its last writes.
  const aside = `${dbPath}.prima-${epoch}`;
  for (const suffix of DB_SIDE_FILES) setAsideIfPresent(dbPath + suffix, epoch);
  return aside;
}

/** Renames a path aside once: a boot that runs again after a crash never overwrites the first copy set aside. */
function setAsideIfPresent(path: string, epoch: number): void {
  const aside = `${path}.prima-${epoch}`;
  if (existsSync(path) && !existsSync(aside)) renameSync(path, aside);
}

export interface PendingChangeInputs {
  stateDir: string;
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
 *    entries that moved are renamed aside, so it starts on an empty DB as a
 *    secondary and never writes into the data it gave away.
 */
export function applyPendingPrimaryChange(inputs: PendingChangeInputs): "restored" | "set-aside" | null {
  const now = inputs.now ?? (() => new Date().toISOString());
  const log = inputs.log ?? ((line: string) => console.warn(line));
  const incoming = join(inputs.stateDir, INCOMING_DIR);
  const manifestPath = join(incoming, MANIFEST_FILE);

  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as SwitchManifest;
    const epoch = manifest.epoch;
    mkdirSync(dirname(inputs.dbPath), { recursive: true });
    // A boot that crashed half way runs this again: the staged DB already moved in, so it is not moved twice.
    const stagedDb = stagedPath(inputs.stateDir, DB_NAME);
    const aside = `${inputs.dbPath}.prima-${epoch}`;
    if (existsSync(stagedDb)) {
      setDatabaseAside(inputs.dbPath, epoch);
      renameSync(stagedDb, inputs.dbPath);
    }
    let transcripts = 0;
    for (const f of manifest.files) {
      if (f.name === DB_NAME) continue;
      const [kind, ...rest] = f.name.split("/");
      const from = stagedPath(inputs.stateDir, f.name);
      const to = kind === "state" ? join(inputs.stateDir, ...rest) : join(inputs.projectsDir, ...rest);
      mkdirSync(dirname(to), { recursive: true });
      if (kind === "state") setAsideIfPresent(to, epoch);
      else transcripts++;
      copyFileSync(from, to);
    }
    writeFileAtomic(join(inputs.appDataDir, PRIMARY_STATE_FILE), JSON.stringify({
      primaryMachineId: manifest.toMachineId, epoch, since: now(),
    }));
    rmSync(join(inputs.appDataDir, RETIRED_FILE), { force: true });
    rmSync(incoming, { recursive: true, force: true });
    log(`[primary] restored the primary from ${manifest.fromMachineId} at epoch ${epoch}: ${JSON.stringify(manifest.counts)}, ${transcripts} transcript files; the previous DB is ${aside}`);
    return "restored";
  }

  const retired = readRetired(inputs.appDataDir);
  if (retired?.pendingSetAside) {
    const aside = setDatabaseAside(inputs.dbPath, retired.epoch);
    for (const entry of STATE_ENTRIES) setAsideIfPresent(join(inputs.stateDir, entry), retired.epoch);
    writeRetired(inputs.appDataDir, { ...retired, pendingSetAside: false });
    log(`[primary] handed over to ${retired.toMachineId} at epoch ${retired.epoch}: the DB is set aside as ${aside} and this server refuses writes`);
    return "set-aside";
  }
  return null;
}
