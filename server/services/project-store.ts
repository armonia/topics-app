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

export class SlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`Project slug already in use: ${slug}`);
    this.name = "SlugConflictError";
  }
}

export class ProjectInUseError extends Error {
  constructor(public readonly worktreeCount: number) {
    super(`Project has ${worktreeCount} worktree(s) — delete them first`);
    this.name = "ProjectInUseError";
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
    patch: { name?: string; color?: string | null; icon?: string | null; incognito?: boolean }
  ): Project | null;
  archive(id: string): Project | null;
  restore(id: string): Project | null;
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
    getById: db.prepare(`SELECT * FROM projects WHERE id = ?`),
    getBySlug: db.prepare(`SELECT * FROM projects WHERE slug = ?`),
    getByPath: db.prepare(`SELECT * FROM projects WHERE path = ?`),
    listActive: db.prepare(
      `SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC`,
    ),
    listArchived: db.prepare(
      `SELECT * FROM projects WHERE archived = 1 ORDER BY updated_at DESC`,
    ),
    listAll: db.prepare(`SELECT * FROM projects ORDER BY updated_at DESC`),
    update: db.prepare(`
      UPDATE projects SET name = $name, color = $color, icon = $icon, incognito = $incognito,
                          updated_at = $updated_at WHERE id = $id
    `),
    setArchived: db.prepare(
      `UPDATE projects SET archived = $archived, updated_at = $updated_at WHERE id = $id`,
    ),
    countWorktrees: db.prepare(
      `SELECT COUNT(*) as n FROM worktrees WHERE project_id = ?`,
    ),
    deleteRow: db.prepare(`DELETE FROM projects WHERE id = ?`),
  };

  function rowToProject(row: any): Project {
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
      let stmt: ReturnType<typeof db.prepare>;
      if (opts?.archived === true) stmt = stmts.listArchived;
      else if (opts?.archived === false || opts?.archived === undefined) stmt = stmts.listActive;
      else stmt = stmts.listAll;
      return (stmt.all() as any[]).map(rowToProject);
    },
    update(id, patch) {
      const existing = stmts.getById.get(id) as any;
      if (!existing) return null;
      const now = new Date().toISOString();
      stmts.update.run({
        $id: id,
        $name: patch.name ?? existing.name,
        $color: patch.color !== undefined ? patch.color : existing.color,
        $icon: patch.icon !== undefined ? patch.icon : existing.icon,
        $incognito: patch.incognito !== undefined ? (patch.incognito ? 1 : 0) : existing.incognito,
        $updated_at: now,
      });
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
      const result = stmts.deleteRow.run(id);
      return result.changes > 0;
    },
  };
}
