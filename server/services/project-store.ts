/**
 * SQL persistence layer for the `projects` table (migration 016).
 *
 * Pure data-access — no broadcasts, no business logic. Routes call this
 * for CRUD, then emit WebSocket envelopes themselves so the broadcast
 * cleanly mirrors the response. Pattern matches the existing
 * `gateway-dispatch.ts` style: a single factory that closes over `db`
 * and returns a typed API surface.
 *
 * Slug uniqueness is enforced at the DB level (UNIQUE INDEX in the
 * migration). On collision, callers receive a `SlugConflictError` and
 * are expected to surface a user-facing 409.
 */

import type { Database } from "bun:sqlite";
import type { Project } from "../types";
import { randomUUID } from "node:crypto";
import { isMergeMode, refuseParent, type FamilyRow, type MergeMode, type ParentRefusal } from "../../shared/project-family";

/** A `projects` row as SQLite returns it (snake_case, booleans as 0/1). */
interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  path: string;
  color: string | null;
  icon: string | null;
  archived: number;
  org_id: string | null;
  owner_person_id: string | null;
  incognito: number;
  parent_id: string | null;
  merge_mode: string | null;
  created_at: string;
  updated_at: string;
}

export class SlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`Project slug already in use: ${slug}`);
    this.name = "SlugConflictError";
  }
}

export class ProjectInUseError extends Error {
  constructor(public readonly worktreeCount: number) {
    super(`Project has ${worktreeCount} worktree(s). Delete them first.`);
    this.name = "ProjectInUseError";
  }
}

/** A refused family change: the reason is one of `refuseParent`'s codes. */
export class ParentRefusedError extends Error {
  constructor(public readonly reason: ParentRefusal) {
    super(`Project family change refused: ${reason}`);
    this.name = "ParentRefusedError";
  }
}

export interface ProjectStore {
  create(input: {
    name: string;
    slug: string;
    path: string;
    color?: string | null;
    icon?: string | null;
    /** Migration 092 — chi lo vede. Li passa la rotta, che sa CHI sta creando. */
    orgId?: string | null;
    ownerPersonId?: string | null;
  }): Project;
  get(id: string): Project | null;
  getBySlug(slug: string): Project | null;
  getByPath(path: string): Project | null;
  list(opts?: { archived?: boolean }): Project[];
  update(
    id: string,
    patch: {
      name?: string; color?: string | null; icon?: string | null; incognito?: boolean;
      /** Moves a project into or out of org visibility. `null` = personal
       *  again, a live org id = shared with that org's members (subject to
       *  each member's grants). Missing = leave the existing value alone. */
      orgId?: string | null;
    }
  ): Project | null;
  archive(id: string): Project | null;
  restore(id: string): Project | null;
  /**
   * Puts a project under a parent (or back to top level with `parentId: null`) and sets
   * whether it shares the parent's board. Throws ParentRefusedError when the family
   * would be deeper than one level, loop, or point at nothing. Tasks are never touched.
   */
  setFamily(id: string, change: { parentId?: string | null; mergeMode?: MergeMode }): Project | null;
  /** Every row as the family logic reads it (live and archived). */
  familyRows(): FamilyRow[];
  /** Removes the row. Throws ProjectInUseError if any worktrees still reference it. */
  delete(id: string): boolean;
  /** Best-effort slug from a name. Caller is responsible for uniqueness checks. */
  slugify(name: string): string;
}

export function createProjectStore(db: Database): ProjectStore {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO projects (id, name, slug, path, color, icon, archived, created_at, updated_at,
                            org_id, owner_person_id)
      VALUES ($id, $name, $slug, $path, $color, $icon, 0, $created_at, $updated_at,
              $org_id, $owner_person_id)
    `),
    getById: db.prepare<ProjectRow, [string]>(`SELECT * FROM projects WHERE id = ?`),
    getBySlug: db.prepare<ProjectRow, [string]>(`SELECT * FROM projects WHERE slug = ?`),
    getByPath: db.prepare<ProjectRow, [string]>(`SELECT * FROM projects WHERE path = ?`),
    listActive: db.prepare<ProjectRow, []>(
      `SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC`,
    ),
    listArchived: db.prepare<ProjectRow, []>(
      `SELECT * FROM projects WHERE archived = 1 ORDER BY updated_at DESC`,
    ),
    listAll: db.prepare<ProjectRow, []>(`SELECT * FROM projects ORDER BY updated_at DESC`),
    update: db.prepare(`
      UPDATE projects SET name = $name, color = $color, icon = $icon, incognito = $incognito,
                          org_id = $org_id, updated_at = $updated_at WHERE id = $id
    `),
    setArchived: db.prepare(
      `UPDATE projects SET archived = $archived, updated_at = $updated_at WHERE id = $id`,
    ),
    countWorktrees: db.prepare(
      `SELECT COUNT(*) as n FROM worktrees WHERE project_id = ?`,
    ),
    deleteRow: db.prepare(`DELETE FROM projects WHERE id = ?`),
  };

  function rowToProject(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      path: row.path,
      color: row.color ?? null,
      icon: row.icon ?? null,
      archived: row.archived === 1,
      orgId: row.org_id ?? null,
      ownerPersonId: row.owner_person_id ?? null,
      incognito: row.incognito === 1,
      parentId: row.parent_id ?? null,
      mergeMode: row.merge_mode === "separa" ? "separa" : "accorpa",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "project";
  }

  function familyRows(): FamilyRow[] {
    return stmts.listAll.all().map((row) => ({
      id: row.id,
      path: row.path,
      name: row.name,
      archived: row.archived === 1,
      parentId: row.parent_id ?? null,
      mergeMode: row.merge_mode === "separa" ? "separa" : "accorpa",
    }));
  }

  return {
    slugify,
    create({ name, slug, path, color, icon, orgId, ownerPersonId }) {
      const now = new Date().toISOString();
      const id = randomUUID();
      try {
        stmts.insert.run({
          $id: id,
          $name: name,
          $slug: slug,
          $path: path,
          $color: color ?? null,
          $icon: icon ?? null,
          $created_at: now,
          $updated_at: now,
          $org_id: orgId ?? null,
          $owner_person_id: ownerPersonId ?? null,
        });
      } catch (err: any) {
        if (
          err?.message?.includes("UNIQUE") &&
          err?.message?.includes("projects.slug")
        ) {
          throw new SlugConflictError(slug);
        }
        throw err;
      }
      const row = stmts.getById.get(id);
      if (!row) throw new Error("Project insert succeeded but row missing");
      return rowToProject(row);
    },
    get(id) {
      const row = stmts.getById.get(id);
      return row ? rowToProject(row) : null;
    },
    getBySlug(slug) {
      const row = stmts.getBySlug.get(slug);
      return row ? rowToProject(row) : null;
    },
    getByPath(path) {
      const row = stmts.getByPath.get(path);
      return row ? rowToProject(row) : null;
    },
    list(opts) {
      let stmt: typeof stmts.listAll;
      if (opts?.archived === true) stmt = stmts.listArchived;
      else if (opts?.archived === false || opts?.archived === undefined) stmt = stmts.listActive;
      else stmt = stmts.listAll;
      return stmt.all().map(rowToProject);
    },
    update(id, patch) {
      const existing = stmts.getById.get(id);
      if (!existing) return null;
      const now = new Date().toISOString();
      stmts.update.run({
        $id: id,
        $name: patch.name ?? existing.name,
        $color: patch.color !== undefined ? patch.color : existing.color,
        $icon: patch.icon !== undefined ? patch.icon : existing.icon,
        $incognito: patch.incognito !== undefined ? (patch.incognito ? 1 : 0) : existing.incognito,
        $org_id: patch.orgId !== undefined ? patch.orgId : existing.org_id,
        $updated_at: now,
      });
      const row = stmts.getById.get(id);
      return row ? rowToProject(row) : null;
    },
    familyRows,
    setFamily(id, change) {
      const existing = stmts.getById.get(id);
      if (!existing) return null;
      const nextParent = change.parentId !== undefined ? change.parentId : (existing.parent_id ?? null);
      if (change.parentId !== undefined) {
        const refusal = refuseParent(familyRows(), id, nextParent);
        if (refusal) throw new ParentRefusedError(refusal);
      }
      // Leaving the family is a decision the boot backfill must respect: a top-level
      // row marked 'separa' is never re-parented. Joining a parent without a mode merges.
      const nextMode = change.mergeMode !== undefined
        ? change.mergeMode
        : change.parentId === null ? "separa"
        : change.parentId !== undefined && !existing.parent_id ? "accorpa"
        : isMergeMode(existing.merge_mode) ? existing.merge_mode : "accorpa";
      db.prepare(`UPDATE projects SET parent_id = $parent, merge_mode = $mode, updated_at = $now WHERE id = $id`)
        .run({ $parent: nextParent, $mode: nextMode, $now: new Date().toISOString(), $id: id });
      const row = stmts.getById.get(id);
      return row ? rowToProject(row) : null;
    },
    archive(id) {
      const now = new Date().toISOString();
      stmts.setArchived.run({ $id: id, $archived: 1, $updated_at: now });
      const row = stmts.getById.get(id);
      return row ? rowToProject(row) : null;
    },
    restore(id) {
      const now = new Date().toISOString();
      stmts.setArchived.run({ $id: id, $archived: 0, $updated_at: now });
      const row = stmts.getById.get(id);
      return row ? rowToProject(row) : null;
    },
    delete(id) {
      const count = (stmts.countWorktrees.get(id) as { n: number } | null)?.n ?? 0;
      if (count > 0) throw new ProjectInUseError(count);
      // Children of a deleted parent become top-level projects again (their cards never moved).
      try { db.prepare(`UPDATE projects SET parent_id = NULL WHERE parent_id = ?`).run(id); } catch { /* old schema: no family columns */ }
      const result = stmts.deleteRow.run(id);
      return result.changes > 0;
    },
  };
}
