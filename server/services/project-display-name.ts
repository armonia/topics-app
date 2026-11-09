/**
 * THE NAME A PROJECT IS SHOWN WITH, decided in one place.
 *
 * The Kanban lanes (`/api/all-boards/projects`) and the Plan tiles
 * (`/api/plan`) used to title and order projects from different sources: the
 * folder name on one side, the registered name on the other. A project
 * registered under a name that differs from its folder came out with another
 * heading and another position in each view. Both routes now ask this module.
 *
 * The rule: the registered name when there is one, otherwise the folder name.
 * Two different projects that would show the same name are told apart by
 * appending their board id, the same way in every view.
 */
import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";

export interface RegisteredProjectRow {
  id: string;
  name: string | null;
  path: string | null;
  /** 1 when archived: an archived project does not make a live one «duplicate». */
  archived?: number | boolean | null;
}

export interface ProjectNameEntry {
  /** The id the boards key on (hash of the path), or the row id when the project has no path. */
  projectId: string;
  /** The name shown, with the id appended when another project shares it. */
  name: string;
  path: string | null;
}

const trimPath = (p: string): string => p.replace(/\/+$/, "");

/** The name before duplicates are told apart: registered if non-blank, else the folder. */
export function projectDisplayName(path: string | null | undefined, registeredName: string | null | undefined): string | null {
  const registered = typeof registeredName === "string" ? registeredName.trim() : "";
  if (registered) return registered;
  return path ? basename(trimPath(path)) || null : null;
}

/** Every registered project, archived or not; an absent table (test bench) is an empty list. */
export function loadRegisteredProjects(db: Database): RegisteredProjectRow[] {
  try {
    return db.query(`SELECT id, name, path, archived FROM projects`).all() as RegisteredProjectRow[];
  } catch {
    // The bench tables of older tests have no `archived` column.
    try { return db.query(`SELECT id, name, path FROM projects`).all() as RegisteredProjectRow[]; } catch { return []; }
  }
}

/**
 * The display names of every project the server knows: the registered ones
 * plus the folders that are known but not registered.
 *
 * The result is keyed by the board id AND by the registered row id, so a
 * caller holding either finds the same entry (the Plan sees board ids, other
 * tables hold `projects.id`).
 */
export function buildProjectNames(
  registered: readonly RegisteredProjectRow[],
  knownDirs: readonly string[] = [],
): Map<string, ProjectNameEntry> {
  type ProjectEntry = { boardId: string; rowId: string | null; base: string; path: string | null; archived: boolean };
  const projectEntries = new Map<string, ProjectEntry>();
  for (const row of registered) {
    const path = row.path ? trimPath(row.path) : null;
    const boardId = path ? projectIdForPath(path) : row.id;
    const base = projectDisplayName(path, row.name) ?? boardId;
    // Two rows on one path are one project: the first registered name wins.
    if (!projectEntries.has(boardId)) projectEntries.set(boardId, { boardId, rowId: row.id, base, path, archived: !!row.archived });
  }
  for (const raw of knownDirs) {
    if (typeof raw !== "string" || !raw.startsWith("/")) continue;
    const path = trimPath(raw);
    const boardId = path ? projectIdForPath(path) : "";
    if (!boardId || projectEntries.has(boardId)) continue;
    projectEntries.set(boardId, { boardId, rowId: null, base: projectDisplayName(path, null) ?? boardId, path, archived: false });
  }
  const sharedBy = new Map<string, number>();
  for (const i of projectEntries.values()) if (!i.archived) sharedBy.set(i.base, (sharedBy.get(i.base) ?? 0) + 1);
  const out = new Map<string, ProjectNameEntry>();
  for (const i of projectEntries.values()) {
    const entry: ProjectNameEntry = {
      projectId: i.boardId,
      name: (sharedBy.get(i.base) ?? 0) > 1 ? `${i.base} (${i.boardId})` : i.base,
      path: i.path,
    };
    out.set(i.boardId, entry);
    if (i.rowId) out.set(i.rowId, entry);
  }
  return out;
}

export interface PickerProject { projectId: string; name: string; path: string }

/**
 * The projects the picker offers, named by the rule above and sorted by name,
 * plus `labelOnly`: projects that are registered but not selectable (a hidden
 * folder, a project the picker skips). Cards still point at those, so the
 * grouped board must head their lane with the same name the Plan gives.
 */
export function listPickerProjects(
  registered: readonly RegisteredProjectRow[],
  dirs: readonly unknown[],
): { projects: PickerProject[]; labelOnly: PickerProject[] } {
  const paths = dirs.filter((d): d is string => typeof d === "string");
  const displayNames = buildProjectNames(registered, paths);
  const seen = new Set<string>();
  const projects: PickerProject[] = [];
  for (const raw of paths) {
    if (!raw.startsWith("/")) continue;
    const path = raw.replace(/\/+$/, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const projectId = projectIdForPath(path);
    projects.push({ projectId, name: displayNames.get(projectId)?.name ?? basename(path), path });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  const listed = new Set(projects.map((p) => p.projectId));
  const labelOnly: PickerProject[] = [];
  for (const entry of displayNames.values()) {
    if (listed.has(entry.projectId)) continue;
    listed.add(entry.projectId);
    labelOnly.push({ projectId: entry.projectId, name: entry.name, path: entry.path ?? "" });
  }
  return { projects, labelOnly };
}
