/**
 * A board id is `basename + hash of the path STRING`, so when a project folder
 * moves (and a symlink is left at the old path) the same project has two ids:
 * the one of the old path and the one of the real path. The cards follow the
 * real path; callers that still use the old id must land on the same board,
 * never on a new empty one.
 *
 * Why it happened (card 266a3e1e): the product has no "the project moved"
 * event. Cards were re-pointed to the new id by hand in the DB, and nothing
 * recorded the old id, so writes on it created ghost boards. This table is
 * that missing record.
 *
 * The alias is PERSISTED in `board_aliases` (old id -> new id). It is learned
 * by scanning the two directory levels above every known project for symlinks
 * that resolve to a known project: the old path need not be registered
 * anywhere, a link left behind is enough. Ids of boards that did not move are
 * never touched, and a board that still holds its own cards while the target
 * holds none is left alone.
 */
import type { Database } from "bun:sqlite";
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectIdForPath } from "../../shared/board";
import { canonicalProjectPath } from "./canonical-project-path";
import { knownProjectPaths } from "./tab-resolver";

/** A scan is a few readdir calls; once per this window is plenty. */
const SCAN_MIN_INTERVAL_MS = 30_000;
const MAX_ENTRIES_PER_DIR = 5000;
const MAX_HOPS = 5;
/** Per requested id: a repeated miss on the same id must not rescan the disk every call. */
const lastMissScan = new Map<string, number>();

const hasCards = (db: Database, projectId: string): boolean => {
  try {
    return !!db.query("SELECT 1 FROM tasks WHERE project_id = ? LIMIT 1").get(projectId);
  } catch {
    return false;
  }
};

/** Board id of a path, following symlinks to the real directory. */
export function canonicalBoardIdForPath(projectPath: string): string {
  return projectIdForPath(canonicalProjectPath(projectPath) || projectPath);
}

function lookup(db: Database, id: string): string | null {
  try {
    const row = db.query("SELECT new_id FROM board_aliases WHERE old_id = ?").get(id) as { new_id: string } | null;
    return row?.new_id ?? null;
  } catch {
    return null;
  }
}

function record(db: Database, oldPath: string, newPath: string): void {
  const oldId = projectIdForPath(oldPath);
  const newId = projectIdForPath(newPath);
  if (oldId === newId) return;
  try {
    db.query("INSERT OR IGNORE INTO board_aliases (old_id, new_id, old_path, created_at) VALUES (?, ?, ?, ?)")
      .run(oldId, newId, oldPath, Date.now());
  } catch { /* table missing on a very old DB: the alias is simply not learned */ }
}

/**
 * Learns the aliases: a known project reached through a different string, or a
 * symlink next to a known project (parent and grandparent level) that resolves
 * to it. Returns how many links were examined that pointed at a project.
 */
export function syncBoardAliases(db: Database): number {
  const real = new Map<string, string>();
  const dirs = new Set<string>();
  for (const p of knownProjectPaths(db)) {
    const canon = canonicalProjectPath(p);
    if (!canon) continue;
    real.set(canon, canon);
    if (canon !== p) record(db, p, canon);
    for (const base of [p, canon]) {
      const parent = dirname(base);
      dirs.add(parent);
      dirs.add(dirname(parent));
    }
  }
  let found = 0;
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
      if (!entry.isSymbolicLink()) continue;
      const link = join(dir, entry.name);
      let target: string;
      try { target = realpathSync(link); } catch { continue; }
      if (!real.has(target)) continue;
      record(db, link, target);
      found++;
    }
  }
  return found;
}

/** Maps an old board id to the id of the board the project lives on now. */
export function resolveBoardAlias(db: Database, projectId: string): string {
  if (!projectId || projectId.startsWith("_") || projectId === "*") return projectId;
  let current = projectId;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let next = lookup(db, current);
    if (!next && hop === 0 && !hasCards(db, current) && Date.now() - (lastMissScan.get(current) ?? 0) > SCAN_MIN_INTERVAL_MS) {
      lastMissScan.set(current, Date.now());
      syncBoardAliases(db);
      next = lookup(db, current);
    }
    if (!next || next === current) break;
    // A board still holding its own cards while the target is empty is not "moved".
    if (hasCards(db, current) && !hasCards(db, next)) break;
    current = next;
  }
  return current;
}

/** Rewrites `/api/boards/<old id>/...` to the current id; other paths pass through. */
export function resolveBoardPath(db: Database, pathname: string): string {
  const match = /^\/api\/boards\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return pathname;
  let id: string;
  try { id = decodeURIComponent(match[1]); } catch { return pathname; }
  const target = resolveBoardAlias(db, id);
  return target === id ? pathname : `/api/boards/${encodeURIComponent(target)}${match[2] ?? ""}`;
}

/** @internal Test hook: lets a test force the next resolve to rescan. */
export function resetBoardAliasScan(): void {
  lastMissScan.clear();
}
