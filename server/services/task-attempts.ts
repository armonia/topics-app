/**
 * Persistenza dei tentativi di fan-out (migration 065).
 *
 * Deliberatamente sottile: nessuna decisione qui dentro, solo righe. Chi lancia
 * i tentativi è il dispatcher, chi sceglie il vincitore è l'umano attraverso la
 * route — questo modulo tiene il conto e garantisce l'unica invariante che conta:
 * **un solo vincitore**, in una transazione, così due click ravvicinati non
 * possono lasciare due tentativi `selected` (e quindi due worktree che credono
 * entrambi di essere la consegna del task).
 *
 * Il resto del sistema non impara un secondo modo di trovare il lavoro di un
 * task: `select()` è accompagnato, nella route, dal ri-puntamento di
 * `tasks.assigned_topic_id` sul topic del vincitore — l'unica indirezione che
 * diff, checks, land, preview e reap già seguono.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AttemptState, TaskAttempt } from "../../shared/task-attempt";

export type { TaskAttempt };

interface Row {
  id: string;
  task_id: string;
  idx: number;
  topic_id: string | null;
  worktree_id: string | null;
  branch: string | null;
  model: string | null;
  state: string;
  commit_sha: string | null;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
  summary: string | null;
  error: string | null;
  agent_ms: number;
  agent_tokens: number;
  created_at: string;
  ended_at: string | null;
  selected_at: string | null;
  no_local_checks_reservation_gb?: number | null;
}

function toAttempt(r: Row): TaskAttempt {
  return {
    id: r.id,
    taskId: r.task_id,
    idx: r.idx,
    topicId: r.topic_id,
    worktreeId: r.worktree_id,
    branch: r.branch,
    model: r.model,
    state: r.state as AttemptState,
    commit: r.commit_sha,
    filesChanged: r.files_changed,
    insertions: r.insertions,
    deletions: r.deletions,
    summary: r.summary,
    error: r.error,
    agentMs: r.agent_ms ?? 0,
    agentTokens: r.agent_tokens ?? 0,
    createdAt: r.created_at,
    endedAt: r.ended_at,
    selectedAt: r.selected_at,
  };
}

export interface CreateAttemptInput {
  taskId: string;
  idx: number;
  model?: string | null;
  noLocalChecksReservationGB?: number | null;
}

/** Ciò che si sa solo DOPO il setup: topic, worktree, branch. */
export interface BindAttemptPatch {
  topicId?: string | null;
  worktreeId?: string | null;
  branch?: string | null;
  model?: string | null;
}

/** La fotografia al termine del turno. */
export interface FinishAttemptPatch {
  state: "delivered" | "failed";
  commit?: string | null;
  filesChanged?: number | null;
  insertions?: number | null;
  deletions?: number | null;
  summary?: string | null;
  error?: string | null;
  agentMs?: number;
  agentTokens?: number;
}

export interface TaskAttemptStore {
  create(input: CreateAttemptInput): TaskAttempt;
  get(id: string): TaskAttempt | null;
  list(taskId: string): TaskAttempt[];
  bind(id: string, patch: BindAttemptPatch): TaskAttempt | null;
  finish(id: string, patch: FinishAttemptPatch): TaskAttempt | null;
  /** Stores the active admission reservation by task id, independent of its topic. */
  setNoLocalChecksReservation(taskId: string, reservationGB: number | null): void;
  getNoLocalChecksReservation(taskId: string): number | null;
  /** Quanti tentativi di questo task hanno ancora un turno vivo. */
  runningCount(taskId: string): number;
  /**
   * Il vincitore, atomicamente: `selected` a lui, `discarded` a tutti gli altri
   * che non fossero già stati scartati. Ritorna null se l'id non è di questo
   * task; ritorna i perdenti perché è chi chiama a doverne reapare i worktree.
   */
  select(taskId: string, attemptId: string): { winner: TaskAttempt; losers: TaskAttempt[] } | null;
  /** Rimuove le righe di un task (il fan-out riparte pulito su un re-dispatch). */
  clear(taskId: string): void;
}

export function createTaskAttemptStore(db: Database): TaskAttemptStore {
  let hasNoLocalChecksReservationColumn = false;
  try {
    hasNoLocalChecksReservationColumn = (db.prepare("PRAGMA table_info(task_attempts)").all() as Array<{ name: string }>)
      .some((column) => column.name === "no_local_checks_reservation_gb");
  } catch { /* older or minimal schemas keep the original attempt shape */ }

  const one = (id: string): TaskAttempt | null => {
    const r = db.prepare("SELECT * FROM task_attempts WHERE id = ?").get(id) as Row | undefined;
    return r ? toAttempt(r) : null;
  };

  return {
    create({ taskId, idx, model, noLocalChecksReservationGB }) {
      const id = randomUUID();
      const now = new Date().toISOString();
      if (hasNoLocalChecksReservationColumn) {
        db.prepare(
          `INSERT INTO task_attempts (id, task_id, idx, model, state, created_at, no_local_checks_reservation_gb)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
        ).run(id, taskId, idx, model ?? null, now, noLocalChecksReservationGB ?? null);
      } else {
        db.prepare(
          `INSERT INTO task_attempts (id, task_id, idx, model, state, created_at)
           VALUES (?, ?, ?, ?, 'running', ?)`,
        ).run(id, taskId, idx, model ?? null, now);
      }
      return one(id)!;
    },

    get: one,

    list(taskId) {
      const rows = db
        .prepare("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY idx ASC")
        .all(taskId) as Row[];
      return rows.map(toAttempt);
    },

    bind(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.topicId !== undefined) { sets.push("topic_id = ?"); params.push(patch.topicId); }
      if (patch.worktreeId !== undefined) { sets.push("worktree_id = ?"); params.push(patch.worktreeId); }
      if (patch.branch !== undefined) { sets.push("branch = ?"); params.push(patch.branch); }
      if (patch.model !== undefined) { sets.push("model = ?"); params.push(patch.model); }
      if (!sets.length) return one(id);
      db.prepare(`UPDATE task_attempts SET ${sets.join(", ")} WHERE id = ?`).run(...(params as never[]), id);
      return one(id);
    },

    finish(id, patch) {
      // Un tentativo già scelto o scartato non torna indietro: il turno zombie
      // che si sveglia dopo la decisione umana non deve riscriverne l'esito.
      const cur = one(id);
      if (!cur || cur.state === "selected" || cur.state === "discarded") return cur;
      db.prepare(
        `UPDATE task_attempts SET state = ?, commit_sha = ?, files_changed = ?, insertions = ?,
           deletions = ?, summary = ?, error = ?, agent_ms = ?, agent_tokens = ?, ended_at = ?
         WHERE id = ?`,
      ).run(
        patch.state,
        patch.commit ?? null,
        patch.filesChanged ?? null,
        patch.insertions ?? null,
        patch.deletions ?? null,
        patch.summary ?? null,
        patch.error ?? null,
        patch.agentMs ?? 0,
        patch.agentTokens ?? 0,
        new Date().toISOString(),
        id,
      );
      return one(id);
    },

    setNoLocalChecksReservation(taskId, reservationGB) {
      if (!hasNoLocalChecksReservationColumn) return;
      if (reservationGB == null) {
        db.prepare("UPDATE task_attempts SET no_local_checks_reservation_gb = NULL WHERE task_id = ?")
          .run(taskId);
        return;
      }
      db.prepare(
        `UPDATE task_attempts SET no_local_checks_reservation_gb = ?
         WHERE id = (SELECT id FROM task_attempts WHERE task_id = ? ORDER BY idx DESC LIMIT 1)`,
      ).run(reservationGB, taskId);
    },

    getNoLocalChecksReservation(taskId) {
      if (!hasNoLocalChecksReservationColumn) return null;
      const r = db.prepare(
        "SELECT no_local_checks_reservation_gb FROM task_attempts WHERE task_id = ? ORDER BY idx DESC LIMIT 1",
      ).get(taskId) as { no_local_checks_reservation_gb?: number | null } | undefined;
      return typeof r?.no_local_checks_reservation_gb === "number" && Number.isFinite(r.no_local_checks_reservation_gb)
        ? r.no_local_checks_reservation_gb
        : null;
    },

    runningCount(taskId) {
      const r = db
        .prepare("SELECT COUNT(*) AS n FROM task_attempts WHERE task_id = ? AND state = 'running'")
        .get(taskId) as { n: number } | undefined;
      return r?.n ?? 0;
    },

    select(taskId, attemptId) {
      const target = one(attemptId);
      if (!target || target.taskId !== taskId) return null;
      const now = new Date().toISOString();
      // Una transazione sola: due click ravvicinati non possono lasciare due
      // `selected`, che vorrebbe dire due worktree convinti di essere la consegna.
      db.transaction(() => {
        db.prepare(
          "UPDATE task_attempts SET state = 'discarded' WHERE task_id = ? AND id != ? AND state != 'discarded'",
        ).run(taskId, attemptId);
        db.prepare(
          "UPDATE task_attempts SET state = 'selected', selected_at = ? WHERE id = ?",
        ).run(now, attemptId);
      })();
      const all = this.list(taskId);
      const winner = all.find((a) => a.id === attemptId)!;
      return { winner, losers: all.filter((a) => a.id !== attemptId) };
    },

    clear(taskId) {
      db.prepare("DELETE FROM task_attempts WHERE task_id = ?").run(taskId);
    },
  };
}
