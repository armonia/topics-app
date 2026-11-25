/**
 * WHICH PROJECT A FOLDER BELONGS TO, for the quota count.
 *
 * `projectIdForPath` hashes the path STRING, so two spellings of one folder
 * (a symlink or junction, a trailing slash, another drive-letter case) would be
 * two projects. Every folder is canonicalised before it is compared or hashed,
 * and a worktree's folder folds onto its project's.
 *
 * A project is identified by the id of its REGISTERED path (`projects.path`),
 * which is what `tasks.project_id` carries; an unregistered folder Topics
 * itself recorded is still a project, keyed on its own canonical path.
 */
import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { projectIdForPath } from "../../shared/board";
import { worktreeRootDir } from "../services/worktree-manager";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** Comparison key of a folder: real path when it exists, forward slashes, no trailing slash, folded case where the disk folds it. */
function folderKey(folder: string, real: Map<string, string>): string {
  let r = real.get(folder);
  if (r === undefined) {
    try { r = realpathSync(folder); } catch { r = folder; }
    real.set(folder, r);
  }
  const k = r.replace(/\\/g, "/").replace(/\/+$/, "");
  return CASE_INSENSITIVE ? k.toLowerCase() : k;
}

export interface ResolvedFolder {
  /** The project's own folder as registered, or the canonical folder itself when no registered project contains it. */
  path: string;
  /** Whether a registered project (or one of its worktrees) contains the folder. */
  registered: boolean;
  /** `projectIdForPath(path)`, or `null` for the home folder (never a project of its own). */
  id: string | null;
}

export interface FolderResolver {
  resolve(folder: string): ResolvedFolder;
  /** The folder of a project id the resolver knows from the registry, for display. */
  pathOfId(projectId: string): string | null;
  /** Every registered project's id and folder, archived ones left out. */
  projects: Array<{ id: string; path: string }>;
}

/**
 * Longest-prefix folder to project resolver, built once per computation from
 * `projects` and `worktrees`.
 *
 * A folder under `<worktrees root>/<project slug>/` is the project's even when
 * the worktree row (and the chat that used it) are gone: that is where the
 * worktree manager puts every worktree, so the deleted ones still name their
 * project.
 */
export function buildFolderResolver(db: Database, worktreesRoot: string = worktreeRootDir()): FolderResolver {
  const real = new Map<string, string>();
  const rows = db.query(
    `SELECT w.abs_path path, p.path project_path FROM worktrees w JOIN projects p ON p.id = w.project_id
     UNION ALL
     SELECT p.path path, p.path project_path FROM projects p`,
  ).all() as Array<{ path: string; project_path: string }>;
  const prefixes = rows.map((r) => ({ key: folderKey(r.path, real), projectPath: r.project_path }));
  // Longest first, so a worktree nested under another match never loses to the shorter one.
  prefixes.sort((a, b) => b.key.length - a.key.length);
  const home = folderKey(homedir(), real);
  const rootKey = folderKey(worktreesRoot, real) + "/";
  const bySlug = new Map((db.query("SELECT slug, path FROM projects").all() as Array<{ slug: string; path: string }>).map((p) => [CASE_INSENSITIVE ? p.slug.toLowerCase() : p.slug, p.path]));

  const projects = (db.query("SELECT path FROM projects WHERE archived = 0").all() as Array<{ path: string }>)
    .map((p) => ({ id: projectIdForPath(p.path), path: p.path }));
  const byId = new Map(projects.map((p) => [p.id, p.path]));
  // A folder with a trailing slash would hash differently from the same one without.
  const clean = (p: string) => p.replace(/[\\/]+$/, "");

  return {
    projects,
    pathOfId: (id) => byId.get(id) ?? null,
    resolve(folder) {
      const key = folderKey(folder, real);
      for (const p of prefixes) {
        if (key === p.key || key.startsWith(p.key + "/")) return { path: p.projectPath, registered: true, id: projectIdForPath(p.projectPath) };
      }
      if (key.startsWith(rootKey)) {
        const projectPath = bySlug.get(key.slice(rootKey.length).split("/")[0]!);
        if (projectPath) return { path: projectPath, registered: true, id: projectIdForPath(projectPath) };
      }
      // The home folder holds scratch sessions, never a project of its own.
      if (key === home) return { path: folder, registered: false, id: null };
      const canonical = clean(real.get(folder) ?? folder);
      return { path: canonical, registered: false, id: projectIdForPath(canonical) };
    },
  };
}

/**
 * The project id a `cwd` folds onto, the same resolution the quota count uses.
 * For a caller that only has a folder (the limit menu): a folder Topics itself
 * hands out IS a project by construction, registered or not.
 */
export function projectIdOfFolder(db: Database, folder: string): string {
  return buildFolderResolver(db).resolve(folder).id ?? projectIdForPath(folder);
}
