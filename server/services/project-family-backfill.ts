/**
 * Gives a parent to the projects that are really worktrees.
 *
 * Before the canonical-project rule, opening a worktree registered the folder as
 * a project of its own: a second board and a second sidebar entry for a repo that
 * already had both. Those rows stay (their cards keep their `project_id`), but
 * they get a `parent_id` pointing at the project that owns the repository, and
 * `merge_mode = 'accorpa'` so the parent's board shows their cards.
 *
 * The parent comes from git's common dir through `canonicalProjectFor` (SQL cannot
 * read it), or, for a folder that no longer exists, from the worktree table and the
 * `{root}/{slug}/...` layout. Nothing else is written: not `tasks`, not `topics`.
 * Idempotent: a row that already has a parent is never looked at again, and a row
 * nobody claims stays as it is.
 */
import type { Database } from "bun:sqlite";
import {
  canonicalProjectFor, projectsInsideWorktrees,
  type CanonicalProjectDeps, type CanonicalProjectRow,
} from "./project-path-resolver";
import { refuseParent } from "../../shared/project-family";
import { loadFamilyRows } from "./project-family-rows";

interface BackfillRow extends CanonicalProjectRow {
  slug: string;
  parentId: string | null;
}

export interface BackfillResult {
  /** Rows that got (or, in a dry run, would get) a parent. */
  assigned: Array<{ id: string; slug: string; path: string; parentId: string; parentSlug: string }>;
  /** Worktree-projects no known project claims: they need the manual merge. */
  unresolved: Array<{ id: string; slug: string; path: string }>;
}

export function backfillProjectParents(
  db: Database,
  deps: CanonicalProjectDeps & { apply?: boolean } = {},
): BackfillResult {
  const result: BackfillResult = { assigned: [], unresolved: [] };
  const family = loadFamilyRows(db);
  // No family columns yet (the migration has not run): nothing to write.
  const columns = (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!columns.includes("parent_id")) return result;

  const slugOf = new Map((db.query("SELECT id, slug FROM projects").all() as Array<{ id: string; slug: string }>).map((r) => [r.id, r.slug]));
  // A top-level row marked 'separa' was taken out of its family by a person: never put back.
  const decided = new Set(family.filter((r) => r.parentId === null && r.mergeMode === "separa").map((r) => r.id));
  const rows: BackfillRow[] = family
    .filter((r) => !r.archived)
    .map((r) => ({ id: r.id, path: r.path, slug: slugOf.get(r.id) ?? r.id, parentId: r.parentId }));

  const worktreeOwner = deps.worktreeOwner ?? ((absPath: string): string | null => {
    try {
      const row = db.query("SELECT project_id FROM worktrees WHERE abs_path = ? LIMIT 1").get(absPath) as { project_id: string } | null;
      return row?.project_id ?? null;
    } catch { return null; }
  });
  const lookup: CanonicalProjectDeps = { ...deps, worktreeOwner };

  const update = db.prepare("UPDATE projects SET parent_id = ?, merge_mode = 'accorpa', updated_at = ? WHERE id = ? AND parent_id IS NULL AND merge_mode <> 'separa'");
  for (const orphan of projectsInsideWorktrees(rows, lookup)) {
    if (decided.has(orphan.id)) continue;
    const parent = canonicalProjectFor(orphan.path, rows.filter((r) => r.id !== orphan.id), lookup);
    // The answer must be a project that can really be a parent (top level, not the row itself).
    if (!parent || refuseParent(family, orphan.id, parent.id) !== null) {
      result.unresolved.push({ id: orphan.id, slug: orphan.slug, path: orphan.path });
      continue;
    }
    if (deps.apply !== false) update.run(parent.id, new Date().toISOString(), orphan.id);
    result.assigned.push({ id: orphan.id, slug: orphan.slug, path: orphan.path, parentId: parent.id, parentSlug: parent.slug });
    // Later rows see this assignment: a parent that just became a child cannot take children.
    const at = family.findIndex((r) => r.id === orphan.id);
    if (at >= 0) family[at] = { ...family[at]!, parentId: parent.id };
  }
  return result;
}
