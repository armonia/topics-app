import type { Database } from "bun:sqlite";
import type { Principal, SubjectKind } from "./grants-query";
import type { AgentStartCapabilityContract } from "../../shared/agent-start-capability";

export const DELEGATED_MAX_ATTEMPTS = 1 as const;
export const DELEGATED_PARALLEL_LIMIT = 1 as const;

/** Git transport is not repository identity. Compare the host/path key. */
export function normalizeRepositoryKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(value);
  let host: string;
  let path: string;
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const url = new URL(value);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return host && path ? `${host.toLowerCase()}/${path.toLowerCase()}` : null;
}

export type AgentStartCapability = AgentStartCapabilityContract;

export interface DelegatedRunPolicy extends AgentStartCapability {
  taskId: string;
  initiatorPersonId: string | null;
  initiatorDeviceId: string;
  /** Absolute wall-clock stop. Null only before the first dispatch phase is recorded. */
  deadlineAt: number | null;
}

interface CapabilityRow {
  id: string;
  recipient_kind: SubjectKind;
  recipient_id: string;
  project_id: string;
  machine_id: string;
  machine_name: string | null;
  repository_key: string;
  model: string;
  effort: string;
  max_duration_minutes: number;
  max_attempts: number;
  fanout: number;
  granted_by_person_id: string;
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

function mapCapability(row: CapabilityRow): AgentStartCapability {
  return {
    id: row.id,
    subjectType: row.recipient_kind,
    subjectId: row.recipient_id,
    projectId: row.project_id,
    machineId: row.machine_id,
    machineName: row.machine_name,
    repositoryKey: row.repository_key,
    model: row.model,
    effort: row.effort,
    maxDurationMinutes: row.max_duration_minutes,
    maxAttempts: DELEGATED_MAX_ATTEMPTS,
    fanout: DELEGATED_PARALLEL_LIMIT,
    grantedByPersonId: row.granted_by_person_id,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

const CAPABILITY_SELECT = `
  SELECT c.*, m.name AS machine_name
    FROM agent_start_capabilities c
    LEFT JOIN machines m ON m.id = c.machine_id`;

export function listAgentStartCapabilities(db: Database, projectId: string): AgentStartCapability[] {
  return (db.query(`${CAPABILITY_SELECT} WHERE c.project_id = ? ORDER BY c.granted_at DESC`)
    .all(projectId) as CapabilityRow[]).map(mapCapability);
}

export function putAgentStartCapability(db: Database, input: {
  subjectType: SubjectKind;
  subjectId: string;
  projectId: string;
  machineId: string;
  repositoryKey: string;
  model: string;
  effort: string;
  maxDurationMinutes: number;
  grantedByPersonId: string;
  now?: number;
  expiresAt?: number | null;
}): AgentStartCapability {
  const now = input.now ?? Date.now();
  const id = crypto.randomUUID();
  const write = db.transaction(() => {
    db.query(`UPDATE agent_start_capabilities SET revoked_at = ?, revoked_by_person_id = ?
               WHERE recipient_kind = ? AND recipient_id = ? AND project_id = ? AND revoked_at IS NULL`)
      .run(now, input.grantedByPersonId, input.subjectType, input.subjectId, input.projectId);
    db.query(`INSERT INTO agent_start_capabilities
      (id, recipient_kind, recipient_id, project_id, machine_id, repository_key, model, effort,
       max_duration_minutes, max_attempts, fanout, granted_by_person_id, granted_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?)`).run(
      id, input.subjectType, input.subjectId, input.projectId, input.machineId,
      input.repositoryKey, input.model, input.effort, input.maxDurationMinutes,
      input.grantedByPersonId, now, input.expiresAt ?? null,
    );
  });
  write();
  const row = db.query(`${CAPABILITY_SELECT} WHERE c.id = ?`).get(id) as CapabilityRow;
  return mapCapability(row);
}

export function revokeAgentStartCapability(db: Database, input: {
  capabilityId: string;
  projectId: string;
  revokedByPersonId: string;
  now?: number;
}): boolean {
  const result = db.query(`UPDATE agent_start_capabilities
      SET revoked_at = ?, revoked_by_person_id = ?
    WHERE id = ? AND project_id = ? AND revoked_at IS NULL`)
    .run(input.now ?? Date.now(), input.revokedByPersonId, input.capabilityId, input.projectId);
  return result.changes === 1;
}

function subjectClause(principals: readonly Principal[]): { sql: string; args: string[] } | null {
  const usable = principals.filter((p) => p.id);
  if (!usable.length) return null;
  return {
    sql: usable.map(() => "(c.recipient_kind = ? AND c.recipient_id = ?)").join(" OR "),
    args: usable.flatMap((p) => [p.kind, p.id]),
  };
}

/**
 * Resolve live authority for one guest and project. A remote capability is
 * effective only with the computer owner's independent repository approval.
 */
export function liveAgentStartCapability(db: Database, input: {
  principals: readonly Principal[];
  projectId: string;
  now?: number;
}): AgentStartCapability | null {
  const subjects = subjectClause(input.principals);
  if (!subjects) return null;
  const now = input.now ?? Date.now();
  const row = db.query(`${CAPABILITY_SELECT}
    WHERE c.project_id = ?
      AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at > ?)
      AND (${subjects.sql})
      AND (
        m.base_url IS NULL OR EXISTS (
          SELECT 1 FROM machine_repository_authorizations a
           WHERE a.machine_id = c.machine_id
             AND a.repository_key = c.repository_key
             AND a.revoked_at IS NULL
        )
      )
    ORDER BY c.granted_at DESC LIMIT 1`).get(input.projectId, now, ...subjects.args) as CapabilityRow | null;
  return row ? mapCapability(row) : null;
}

/** The immutable policy copied onto a queued task, revalidated before every seam. */
export function delegatedPolicyForTask(db: Database, taskId: string, now = Date.now()): DelegatedRunPolicy | null {
  const row = db.query(`
    SELECT c.*, m.name AS machine_name,
           t.run_initiator_person_id, t.run_initiator_device_id,
           dra.deadline_at AS run_deadline_at
      FROM agent_start_capabilities c
      LEFT JOIN machines m ON m.id = c.machine_id
      JOIN tasks t ON t.delegated_start_capability_id = c.id
      JOIN devices d ON d.id = t.run_initiator_device_id AND d.revoked_at IS NULL
      LEFT JOIN people p ON p.id = d.person_id
      LEFT JOIN delegated_run_audit dra ON dra.id = (
        SELECT id FROM delegated_run_audit WHERE task_id = t.id ORDER BY id DESC LIMIT 1
      )
    WHERE t.id = ?
      AND t.project_id = c.project_id
      AND t.machine_id = c.machine_id
      AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at > ?)
      AND (dra.deadline_at IS NULL OR dra.deadline_at > ?)
      AND m.id IS NOT NULL
      AND t.run_initiator_person_id IS d.person_id
      AND (d.person_id IS NULL OR (p.id IS NOT NULL AND p.revoked_at IS NULL))
      AND (
        (c.recipient_kind = 'device' AND c.recipient_id = d.id) OR
        (c.recipient_kind = 'person' AND c.recipient_id = p.id) OR
        (c.recipient_kind = 'org' AND p.id IS NOT NULL AND EXISTS (
          SELECT 1 FROM org_members om
          JOIN orgs o ON o.id = om.org_id
          WHERE om.org_id = c.recipient_id
            AND om.person_id = p.id
            AND om.revoked_at IS NULL
            AND om.local_blocked_at IS NULL
            AND o.revoked_at IS NULL
        ))
      )
      AND (
        m.base_url IS NULL OR EXISTS (
          SELECT 1 FROM machine_repository_authorizations a
           WHERE a.machine_id = c.machine_id
             AND a.repository_key = c.repository_key
             AND a.revoked_at IS NULL
        )
      )`).get(taskId, now, now) as (CapabilityRow & {
        run_initiator_person_id: string | null;
        run_initiator_device_id: string;
        run_deadline_at: number | null;
      }) | null;
  if (row) {
    return {
      ...mapCapability(row),
      maxDurationMinutes: row.max_duration_minutes,
      deadlineAt: row.run_deadline_at,
      taskId,
      initiatorPersonId: row.run_initiator_person_id,
      initiatorDeviceId: row.run_initiator_device_id,
    };
  }

  // On the execution computer the project-owner capability belongs to the
  // origin installation. The immutable confined envelope is the local source
  // of truth and survives a node restart without widening to an owner token.
  const node = db.query(`SELECT n.*, m.name AS machine_name
      FROM delegated_node_runs n
      JOIN delegated_node_authorizations a ON a.id = n.authorization_id
      LEFT JOIN machines m ON m.id = n.machine_id
      JOIN tasks t ON t.id = n.run_id
     WHERE n.run_id = ?
       AND t.project_id = n.project_id
       AND n.revoked_at IS NULL
       AND (n.expires_at IS NULL OR n.expires_at > ?)
       AND n.deadline_at > ?
       AND a.revoked_at IS NULL
       AND (a.expires_at IS NULL OR a.expires_at > ?)
       AND a.capability_id = n.capability_id
       AND a.subject_device_id = n.subject_device_id
       AND a.subject_person_id IS n.subject_person_id
       AND a.machine_id = n.machine_id
       AND a.repository_key = n.repository_key
       AND a.model = n.model
       AND a.effort = n.effort
       AND a.max_duration_minutes = n.max_duration_minutes
       AND a.max_attempts = n.max_attempts
       AND a.fanout = n.fanout`).get(taskId, now, now, now) as {
        capability_id: string; project_id: string; subject_person_id: string | null;
        subject_device_id: string; machine_id: string; machine_name: string | null;
        repository_key: string; model: string; effort: string; max_duration_minutes: number;
        max_attempts: number; fanout: number; created_at: number; expires_at: number | null;
        deadline_at: number;
      } | null;
  if (!node || node.max_attempts !== 1 || node.fanout !== 1) return null;
  return {
    id: node.capability_id,
    subjectType: node.subject_person_id ? "person" : "device",
    subjectId: node.subject_person_id ?? node.subject_device_id,
    projectId: node.project_id,
    machineId: node.machine_id,
    machineName: node.machine_name,
    repositoryKey: node.repository_key,
    model: node.model,
    effort: node.effort,
    maxDurationMinutes: node.max_duration_minutes,
    deadlineAt: node.deadline_at,
    maxAttempts: DELEGATED_MAX_ATTEMPTS,
    fanout: DELEGATED_PARALLEL_LIMIT,
    grantedByPersonId: "",
    grantedAt: node.created_at,
    expiresAt: node.expires_at,
    revokedAt: null,
    taskId,
    initiatorPersonId: node.subject_person_id,
    initiatorDeviceId: node.subject_device_id,
  };
}

export function queueDelegatedRun(db: Database, input: {
  taskId: string;
  capability: AgentStartCapability;
  initiatorPersonId: string | null;
  initiatorDeviceId: string;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  db.transaction(() => {
    const task = db.query("SELECT project_id, status, delegated_start_capability_id FROM tasks WHERE id = ?")
      .get(input.taskId) as { project_id: string; status: string; delegated_start_capability_id: string | null } | null;
    if (!task || task.project_id !== input.capability.projectId) throw new Error("capability_project_mismatch");
    if (task.status !== "backlog" || task.delegated_start_capability_id) throw new Error("task_not_executable");
    db.query(`UPDATE tasks SET status = 'todo', machine_id = ?, model = ?, model_effort = ?,
        delegated_start_capability_id = ?, run_initiator_person_id = ?, run_initiator_device_id = ?, updated_at = ?
      WHERE id = ?`).run(
      input.capability.machineId, input.capability.model, input.capability.effort,
      input.capability.id, input.initiatorPersonId, input.initiatorDeviceId,
      new Date(now).toISOString(), input.taskId,
    );
    db.query(`INSERT INTO delegated_run_audit
      (capability_id, task_id, project_id, initiator_person_id, initiator_device_id,
       machine_id, repository_key, model, effort, max_duration_minutes, max_attempts,
       fanout, phase, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,1,'queued',?,?)`).run(
      input.capability.id, input.taskId, input.capability.projectId, input.initiatorPersonId,
      input.initiatorDeviceId, input.capability.machineId, input.capability.repositoryKey,
      input.capability.model, input.capability.effort, input.capability.maxDurationMinutes, now, now,
    );
  })();
}

export function appendDelegatedRunAudit(db: Database, input: {
  taskId: string;
  phase: "dispatch" | "resume" | "cancelled" | "completed" | "failed";
  executionSessionId?: string | null;
  outcome?: string | null;
  now?: number;
}): boolean | number {
  const now = input.now ?? Date.now();
  if (input.phase === "dispatch" || input.phase === "resume") {
    return db.transaction(() => {
      // This read and the write below share one SQLite transaction: revocation,
      // recipient/device changes and the audit row cannot change at the seam
      // between authorization and persistence.
      const policy = delegatedPolicyForTask(db, input.taskId, now);
      if (!policy) return false;

      // Node-local delegated runs already carry their immutable absolute
      // deadline in delegated_node_runs. There is no origin audit row on that
      // installation, so returning it is the verified begin operation there.
      const audit = db.query(`SELECT id, capability_id
          FROM delegated_run_audit
         WHERE task_id = ?
         ORDER BY id DESC LIMIT 1`).get(input.taskId) as { id: number; capability_id: string } | null;
      if (!audit) return policy.deadlineAt ?? false;
      if (audit.capability_id !== policy.id) return false;

      const result = db.query(`UPDATE delegated_run_audit
          SET phase = ?, execution_session_id = COALESCE(?, execution_session_id), outcome = ?,
              deadline_at = COALESCE(deadline_at, ? + max_duration_minutes * 60000),
              updated_at = ?
        WHERE id = ?
          AND task_id = ?
          AND capability_id = ?
          AND phase IN ('queued', 'dispatch', 'resume')`)
        .run(input.phase, input.executionSessionId ?? null, input.outcome ?? null,
          now, now, audit.id, input.taskId, policy.id);
      if (result.changes !== 1) return false;
      const persisted = db.query("SELECT deadline_at FROM delegated_run_audit WHERE id = ?")
        .get(audit.id) as { deadline_at: number | null } | null;
      return persisted?.deadline_at ?? false;
    })();
  }
  const result = db.query(`UPDATE delegated_run_audit
      SET phase = ?, execution_session_id = COALESCE(?, execution_session_id), outcome = ?,
          updated_at = ?
    WHERE id = (SELECT id FROM delegated_run_audit WHERE task_id = ? ORDER BY id DESC LIMIT 1)`)
    .run(input.phase, input.executionSessionId ?? null, input.outcome ?? null, now, input.taskId);
  return result.changes === 1;
}
