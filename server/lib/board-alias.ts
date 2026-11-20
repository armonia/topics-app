/**
 * A board id is `basename + hash of the path STRING`, so when a project folder
 * moves (and a symlink is left at the old path) the same project has two ids:
 * the one of the old path and the one of the real path. The cards follow the
 * real path; callers that still use the old id must land on the same board,
 * never on a new empty one.
 *
 * The alias is derived, not stored: every known project path whose id equals
 * the requested one is resolved through the filesystem, and its canonical id is
 * the answer. A board that still holds its own cards while the canonical one
 * holds none is left alone, so ids of boards that did not move never change.
 */
import type { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";
import { canonicalProjectPath } from "./canonical-project-path";
import { knownProjectPaths } from "./tab-resolver";

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

/** Maps an old board id to the id of the board the project lives on now. */
export function resolveBoardAlias(db: Database, projectId: string): string {
  if (!projectId || projectId.startsWith("_") || projectId === "*") return projectId;
  const targets = new Set<string>();
  for (const path of knownProjectPaths(db)) {
    if (projectIdForPath(path) !== projectId) continue;
    const target = canonicalBoardIdForPath(path);
    if (target !== projectId) targets.add(target);
  }
  if (targets.size !== 1) return projectId;
  const [target] = [...targets];
  if (hasCards(db, projectId) && !hasCards(db, target)) return projectId;
  return target;
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
