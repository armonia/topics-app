/**
 * SQL persistence layer for the `worktrees` table (migration 017).
 *
 * Same shape as `project-store.ts`: pure data access, factory closes
 * over a Database. Routes call this directly for reads and through
 * `WorktreeManager` for the materialise side-effects.
 *
 * Status state machine (set by the manager, observed by everyone):
 *
 *   pending ─→ ready    (git worktree add succeeded)
 *           └→ error    (git failed; row preserved with errorMessage)
 *
 * The row is created upfront in `pending` so the WS broadcast can reach
 * the UI before the disk operation completes.
 */

import type { Database } from "bun:sqlite";
import type { Worktree } from "../types";
import { randomUUID } from "node:crypto";

export class WorktreeNameConflictError extends Error {
  constructor(public readonly projectId: string, public readonly name: string) {
    super(`Worktree name '${name}' already in use for project ${projectId}`);
    this.name = "WorktreeNameConflictError";
  }
}

export class WorktreePathConflictError extends Error {
  constructor(public readonly absPath: string) {
    super(`Worktree path already in use: ${absPath}`);
    this.name = "WorktreePathConflictError";
  }
}

export interface WorktreeStore {
  create(input: {
    projectId: string;
    name: string;
    branchName: string | null;
    baseRef: string | null;
    mode: "branch" | "reuse" | "detached";
    absPath: string;
  }): Worktree;
  get(id: string): Worktree | null;
  getByName(projectId: string, name: string): Worktree | null;
  /** The worktree checked out AT this absolute path, if any (`abs_path` is
   *  UNIQUE, so this is a lookup and never a choice). It is how a directory
   *  answers "which project is this, and which branch am I on" for callers
   *  that only ever see a cwd: a sub-agent's isolation, the branch a parent
   *  reads back, the sweep's live-session guard. */
  getByAbsPath(absPath: string): Worktree | null;
  list(opts?: {
    projectId?: string;
    status?: "pending" | "ready" | "error";
  }): Worktree[];
  /** Returns the set of names already used for a project (for the naming generator). */
  listNamesForProject(projectId: string): Set<string>;
  update(
    id: string,
    patch: Partial<{
      name: string;
      branchName: string | null;
      baseRef: string | null;
      isPushed: boolean;
      branchRenamed: boolean;
      status: "pending" | "ready" | "error";
      errorMessage: string | null;
    }>,
  ): Worktree | null;
  delete(id: string): boolean;
}

export function createWorktreeStore(db: Database): WorktreeStore {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO worktrees
        (id, project_id, name, branch_name, base_ref, mode, abs_path,
         is_pushed, branch_renamed, status, error_message, created_at, updated_at)
      VALUES
        ($id, $project_id, $name, $branch_name, $base_ref, $mode, $abs_path,
         0, 0, 'pending', NULL, $created_at, $updated_at)
    `),
    getById: db.prepare(`SELECT * FROM worktrees WHERE id = ?`),
    getByName: db.prepare(
      `SELECT * FROM worktrees WHERE project_id = ? AND name = ?`,
    ),
    getByAbsPath: db.prepare(`SELECT * FROM worktrees WHERE abs_path = ?`),
    listAll: db.prepare(`SELECT * FROM worktrees ORDER BY updated_at DESC`),
    listByProject: db.prepare(
      `SELECT * FROM worktrees WHERE project_id = ? ORDER BY updated_at DESC`,
    ),
    listByStatus: db.prepare(
      `SELECT * FROM worktrees WHERE status = ? ORDER BY updated_at DESC`,
    ),
    listByProjectStatus: db.prepare(
      `SELECT * FROM worktrees WHERE project_id = ? AND status = ? ORDER BY updated_at DESC`,
    ),
    listNamesForProject: db.prepare(
      `SELECT name FROM worktrees WHERE project_id = ?`,
    ),
    deleteRow: db.prepare(`DELETE FROM worktrees WHERE id = ?`),
    forgetBoundSessions: db.prepare(
      `DELETE FROM claude_code_sessions
         WHERE session_key IN (SELECT session_key FROM topics WHERE worktree_id = ?)`,
    ),
  };

  function rowToWorktree(row: any): Worktree {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      branchName: row.branch_name ?? null,
      baseRef: row.base_ref ?? null,
      mode: row.mode,
      absPath: row.abs_path,
      isPushed: row.is_pushed === 1,
      branchRenamed: row.branch_renamed === 1,
      status: row.status,
      errorMessage: row.error_message ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    create({ projectId, name, branchName, baseRef, mode, absPath }) {
      const now = new Date().toISOString();
      const id = randomUUID();
      try {
        stmts.insert.run({
          $id: id,
          $project_id: projectId,
          $name: name,
          $branch_name: branchName,
          $base_ref: baseRef,
          $mode: mode,
          $abs_path: absPath,
          $created_at: now,
          $updated_at: now,
        });
      } catch (err: any) {
        const msg = String(err?.message || "");
        if (msg.includes("UNIQUE") && msg.includes("worktrees.abs_path")) {
          throw new WorktreePathConflictError(absPath);
        }
        if (msg.includes("UNIQUE") && msg.includes("idx_worktrees_project_name")) {
          throw new WorktreeNameConflictError(projectId, name);
        }
        // SQLite UNIQUE INDEX errors mention the index name; fall through
        // for other constraint violations.
        throw err;
      }
      const row = stmts.getById.get(id);
      if (!row) throw new Error("Worktree insert succeeded but row missing");
      return rowToWorktree(row);
    },
    get(id) {
      const row = stmts.getById.get(id);
      return row ? rowToWorktree(row) : null;
    },
    getByName(projectId, name) {
      const row = stmts.getByName.get(projectId, name);
      return row ? rowToWorktree(row) : null;
    },
    getByAbsPath(absPath) {
      const row = stmts.getByAbsPath.get(absPath);
      return row ? rowToWorktree(row) : null;
    },
    list(opts) {
      let stmt: ReturnType<typeof db.prepare>;
      let params: unknown[] = [];
      if (opts?.projectId && opts?.status) {
        stmt = stmts.listByProjectStatus;
        params = [opts.projectId, opts.status];
      } else if (opts?.projectId) {
        stmt = stmts.listByProject;
        params = [opts.projectId];
      } else if (opts?.status) {
        stmt = stmts.listByStatus;
        params = [opts.status];
      } else {
        stmt = stmts.listAll;
      }
      return (stmt.all(...(params as any[])) as any[]).map(rowToWorktree);
    },
    listNamesForProject(projectId) {
      const rows = stmts.listNamesForProject.all(projectId) as { name: string }[];
      return new Set(rows.map((r) => r.name));
    },
    update(id, patch) {
      const existing = stmts.getById.get(id) as any;
      if (!existing) return null;
      const now = new Date().toISOString();
      const next = {
        name: patch.name ?? existing.name,
        branch_name:
          patch.branchName !== undefined ? patch.branchName : existing.branch_name,
        base_ref:
          patch.baseRef !== undefined ? patch.baseRef : existing.base_ref,
        is_pushed:
          patch.isPushed !== undefined ? (patch.isPushed ? 1 : 0) : existing.is_pushed,
        branch_renamed:
          patch.branchRenamed !== undefined
            ? patch.branchRenamed
              ? 1
              : 0
            : existing.branch_renamed,
        status: patch.status ?? existing.status,
        error_message:
          patch.errorMessage !== undefined
            ? patch.errorMessage
            : existing.error_message,
      };
      try {
        db.prepare(
          `UPDATE worktrees SET name = ?, branch_name = ?, base_ref = ?, is_pushed = ?, branch_renamed = ?, status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
        ).run(
          next.name,
          next.branch_name,
          next.base_ref,
          next.is_pushed,
          next.branch_renamed,
          next.status,
          next.error_message,
          now,
          id,
        );
      } catch (err: any) {
        const msg = String(err?.message || "");
        if (
          msg.includes("UNIQUE") &&
          msg.includes("idx_worktrees_project_name")
        ) {
          throw new WorktreeNameConflictError(existing.project_id, next.name);
        }
        throw err;
      }
      const row = stmts.getById.get(id);
      return row ? rowToWorktree(row) : null;
    },
    delete(id) {
      // Un worktree reapato porta via il suo checkout — la cwd della sessione
      // Claude che ci girava. Un topic legato a questo worktree conserva una riga
      // claude_code_sessions il cui transcript vive nella project-dir derivata dal
      // worktree; sparito il checkout, un `--resume` lì è condannato e il topic si
      // congela sull'ultimo turno (orfano-da-reap: vedi l'incidente "quadra").
      // Dimentichiamo quelle sessioni nello STESSO passo in cui muore il binding
      // (la FK azzera worktree_id): il turno successivo nasce fresco nel progetto
      // base, seedato col recap della history dal DB — esattamente come la
      // lost-session recovery. Deve girare PRIMA del delete della riga, altrimenti
      // la FK ha già azzerato worktree_id e la subquery non trova nulla. La chat
      // visibile e il transcript su disco restano intatti; cade solo il puntatore
      // (ormai non resumabile) alla sessione.
      stmts.forgetBoundSessions.run(id);
      const result = stmts.deleteRow.run(id);
      return result.changes > 0;
    },
  };
}
