/**
 * The bar behind `scripts/worktree-orphans.ts --check-projects`: a project whose
 * own `path` is a worktree, and that has no parent project, is a board a
 * worktree opened by itself. The check reads the projects table (read-only) and
 * says which rows are in that state.
 *
 * `parent_id` arrives with the accorpa/separa migration; until the column
 * exists every row counts as parentless, which is the honest answer.
 */
import { Database } from "bun:sqlite";
import { projectsInsideWorktrees, type GitCheckoutFacts } from "./project-path-resolver";

export interface ProjectRowForCheck {
  id: string;
  slug: string;
  path: string;
  parentId: string | null;
}

/** Non-archived projects of a database, with `parent_id` when the column exists. */
export function readProjectsForCheck(db: Database): ProjectRowForCheck[] {
  const cols = (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name);
  const parent = cols.includes("parent_id") ? "parent_id" : "NULL";
  const rows = db
    .prepare(`SELECT id, slug, path, ${parent} AS parentId FROM projects WHERE archived = 0`)
    .all() as ProjectRowForCheck[];
  return rows;
}

export interface ProjectsCheckResult {
  total: number;
  offenders: ProjectRowForCheck[];
}

export function checkProjectsAgainstWorktrees(
  rows: readonly ProjectRowForCheck[],
  deps: { worktreeRoot?: string; gitFacts?: (dir: string) => GitCheckoutFacts | null } = {},
): ProjectsCheckResult {
  return { total: rows.length, offenders: projectsInsideWorktrees(rows, deps) };
}

/** Opens `dbPath` read-only, prints the offenders and returns the exit code (1 when any). */
export function runProjectsCheck(dbPath: string, worktreeRoot?: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const { total, offenders } = checkProjectsAgainstWorktrees(readProjectsForCheck(db), { worktreeRoot });
    for (const p of offenders) console.log(`worktree-project  ${p.slug.padEnd(24)} ${p.path}  (no parent_id)`);
    console.log(`${total} projects, ${offenders.length} inside a worktree without a parent`);
    return offenders.length > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}
