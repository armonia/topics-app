/**
 * WHAT TOPICS MADE UNDER A WORKTREE ROOT, written under that root (change
 * worktree-standard, data safety).
 *
 * On 24/11/2026 a GC pass without an isolated home removed 30 real folders: it
 * treated every folder under `{root}/{slug}` that git did not list as a leftover.
 * A folder with no row and no `.git` says nothing about who made it, so the GC
 * now needs a PROOF before it moves one, and that proof is written here, by
 * Topics, at the moment it makes the folder:
 *
 *   {root}/.topics-worktree-root          the sentinel: Topics uses this root
 *   {root}/.topics-owned/{slug}/{name}    one marker per folder Topics made
 *   {root}/.quarantine/{day}-{ms}/{slug}/{name}   where a ghost goes instead of `rm`;
 *                                         `{ms}` is the moment of the move, the clock of the purge
 *
 * Everything lives in dot-folders at the first level, which the scan skips, and
 * nothing lives inside a checkout (a file there would show up in `git status`).
 * A folder without a marker is only ever listed. A quarantined folder is deleted
 * after N days, and until then it can be moved back by hand.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, relative, isAbsolute, sep } from "node:path";

export const ROOT_SENTINEL_FILE = ".topics-worktree-root";
export const OWNED_DIR = ".topics-owned";
export const QUARANTINE_DIR = ".quarantine";

const DAY_MS = 24 * 3600_000;

/** A filesystem error that is not "it is not there": the caller must then keep, never assume absence. */
function notMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code !== "ENOENT";
}

/** True when `path` does not exist; false when it exists OR when the answer is unknown (EACCES, EIO...). */
export function surelyAbsent(path: string): boolean {
  try { lstatSync(path); return false; } catch (err) { return !notMissing(err); }
}

export function hasRootSentinel(root: string): boolean {
  try { return lstatSync(join(root, ROOT_SENTINEL_FILE)).isFile(); } catch { return false; }
}

/** Writes the sentinel (and the root) when missing. Best effort: false when the disk refused. */
export function writeRootSentinel(root: string, now: Date = new Date()): boolean {
  try {
    mkdirSync(root, { recursive: true });
    const file = join(root, ROOT_SENTINEL_FILE);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ createdAt: now.toISOString() }) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** `{slug}/{name}` of a folder exactly two levels under the root, else null. */
export function slugAndName(root: string, absPath: string): { slug: string; name: string } | null {
  const rel = relative(root, absPath);
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) return null;
  const parts = rel.split(sep);
  if (parts.length !== 2 || parts.some((p) => !p || p.startsWith(".") || p.startsWith("_"))) return null;
  return { slug: parts[0]!, name: parts[1]! };
}

const markerPath = (root: string, slug: string, name: string): string => join(root, OWNED_DIR, slug, name);

/** Records that Topics made `{root}/{slug}/{name}`. Best effort. */
export function markFolderOwned(root: string, absPath: string, info: { worktreeId?: string; projectId?: string } = {}): boolean {
  const at = slugAndName(root, absPath);
  if (!at) return false;
  try {
    const file = markerPath(root, at.slug, at.name);
    if (existsSync(file)) return true;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...info, createdAt: new Date().toISOString() }) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Topics wrote the marker for this folder. Any doubt (unreadable ledger) is "no". */
export function folderOwned(root: string, absPath: string): boolean {
  const at = slugAndName(root, absPath);
  if (!at) return false;
  try { return lstatSync(markerPath(root, at.slug, at.name)).isFile(); } catch { return false; }
}

/** Drops the marker of a folder that is gone. */
export function forgetFolderOwned(root: string, absPath: string): void {
  const at = slugAndName(root, absPath);
  if (!at) return;
  try { unlinkSync(markerPath(root, at.slug, at.name)); } catch { /* nothing to forget */ }
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Moves a folder into the quarantine of its root and returns where it went, or
 * null when the move could not be done (then nothing happened). A rename on the
 * same disk: instant, and the content is intact.
 */
export function quarantineFolder(root: string, absPath: string, now: Date = new Date()): string | null {
  const at = slugAndName(root, absPath);
  if (!at) return null;
  // The folder name carries the exact moment of the move: the purge counts from it, not from the day.
  const target = join(root, QUARANTINE_DIR, `${dayOf(now)}-${now.getTime()}`, at.slug, at.name);
  if (!surelyAbsent(target)) return null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(absPath, target);
  } catch {
    return null;
  }
  forgetFolderOwned(root, absPath);
  return target;
}

export interface QuarantinedFolder {
  /** Where it sits now. */
  path: string;
  /** Where it came from: moving it back there restores it. */
  from: string;
  /** Since when it is in quarantine, ms. */
  sinceMs: number;
}

/**
 * When the folders under `{root}/.quarantine/{dir}` were moved there: the `{ms}` of
 * `{day}-{ms}`. A bare `{day}` (no moment recorded) counts from the END of that UTC
 * day, never earlier than the move. Anything else is not a quarantine folder: null.
 */
function movedAt(dir: string): number | null {
  const stamped = /^\d{4}-\d{2}-\d{2}-(\d{10,})$/.exec(dir);
  if (stamped) return Number(stamped[1]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dir)) return null;
  const day = Date.parse(dir);
  return Number.isFinite(day) ? day + DAY_MS : null;
}

/** Everything in the quarantine of a root. A root without one is an empty list. */
export function listQuarantine(root: string): QuarantinedFolder[] {
  const base = join(root, QUARANTINE_DIR);
  const out: QuarantinedFolder[] = [];
  let days: string[] = [];
  try { days = readdirSync(base); } catch { return out; }
  for (const day of days) {
    const since = movedAt(day);
    if (since === null) continue;
    let slugs: string[] = [];
    try { slugs = readdirSync(join(base, day)); } catch { continue; }
    for (const slug of slugs) {
      let names: string[] = [];
      try { names = readdirSync(join(base, day, slug)); } catch { continue; }
      for (const name of names) out.push({ path: join(base, day, slug, name), from: join(root, slug, name), sinceMs: since });
    }
  }
  return out;
}

/**
 * Deletes what has been in quarantine for `days` days or more. Only real
 * directories exactly three levels under `{root}/.quarantine` are deleted (a
 * link is unlinked by `rm`, never followed). Returns how many went.
 */
export async function purgeQuarantine(
  root: string,
  days: number,
  now: number = Date.now(),
  fsRm: (path: string) => Promise<void> = (p) => rm(p, { recursive: true, force: true }),
): Promise<number> {
  const base = join(root, QUARANTINE_DIR);
  let purged = 0;
  for (const q of listQuarantine(root)) {
    if (now - q.sinceMs < days * DAY_MS) continue;
    const rel = relative(base, q.path).split(sep);
    if (rel.length !== 3 || rel.some((p) => !p || p === "..")) continue;
    try { if (!lstatSync(q.path).isDirectory()) continue; } catch { continue; }
    await fsRm(q.path);
    purged++;
    // Empty day and slug folders go too; a non-empty one stays (rmdir refuses).
    for (const dir of [dirname(q.path), dirname(dirname(q.path))]) { try { rmdirSync(dir); } catch { /* not empty */ } }
  }
  return purged;
}

/** The quarantined folder at this path, in this root, or null. */
export function findQuarantined(root: string, quarantinedPath: string): QuarantinedFolder | null {
  return listQuarantine(root).find((x) => x.path === quarantinedPath) ?? null;
}

/**
 * Moves a quarantined folder back where it came from. Refused when the origin is
 * taken again. The marker is NOT written back: a person restored it on purpose,
 * and with the marker the next pass would move it to quarantine again.
 */
export function restoreQuarantined(root: string, quarantinedPath: string): string | null {
  const q = findQuarantined(root, quarantinedPath);
  if (!q || !surelyAbsent(q.from)) return null;
  try {
    mkdirSync(dirname(q.from), { recursive: true });
    renameSync(q.path, q.from);
    return q.from;
  } catch {
    return null;
  }
}

/**
 * The roots Topics used before, read off its own rows: a row at
 * `{root}/{slug}/{name}` whose `{slug}` is the slug of a known project, and whose
 * `{root}` carries the sentinel. Without the sentinel nothing is claimed: a path
 * that only looks like a root is somebody else's folder.
 */
export function pastRootsFromRows(
  rows: ReadonlyArray<{ absPath: string }>,
  projectSlugs: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const parent = dirname(r.absPath);
    if (!projectSlugs.has(basename(parent))) continue;
    const root = dirname(parent);
    if (root === parent || out.has(root)) continue;
    if (hasRootSentinel(root)) out.add(root);
  }
  return [...out];
}
