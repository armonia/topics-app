/**
 * The durable, separate authority behind a guest-requested agent start.
 *
 * @covers GUEST-13, GUEST-14, GUEST-15, GUEST-16, GUEST-17
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendDelegatedRunAudit,
  delegatedPolicyForTask,
  liveAgentStartCapability,
  normalizeRepositoryKey,
  putAgentStartCapability,
  queueDelegatedRun,
  revokeAgentStartCapability,
} from "./delegated-agent-start";

function database(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT, revoked_at INTEGER)`);
  db.run(`CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, person_id TEXT, revoked_at INTEGER)`);
  db.run(`CREATE TABLE orgs (id TEXT PRIMARY KEY, revoked_at INTEGER)`);
  db.run(`CREATE TABLE org_members (org_id TEXT, person_id TEXT, revoked_at INTEGER, local_blocked_at INTEGER)`);
  db.run(`CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT, base_url TEXT)`);
  db.run(`CREATE TABLE agent_start_capabilities (
    id TEXT PRIMARY KEY, recipient_kind TEXT, recipient_id TEXT, project_id TEXT,
    machine_id TEXT, repository_key TEXT, model TEXT, effort TEXT,
    max_duration_minutes INTEGER, max_attempts INTEGER, fanout INTEGER,
    granted_by_person_id TEXT, granted_at INTEGER, expires_at INTEGER,
    revoked_at INTEGER, revoked_by_person_id TEXT)`);
  db.run(`CREATE TABLE machine_repository_authorizations (
    id TEXT PRIMARY KEY, machine_id TEXT, repository_key TEXT,
    authorized_by_person_id TEXT, authorized_at INTEGER, revoked_at INTEGER,
    revoked_by_person_id TEXT)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT, status TEXT, machine_id TEXT, model TEXT,
    model_effort TEXT, updated_at TEXT, delegated_start_capability_id TEXT,
    run_initiator_person_id TEXT, run_initiator_device_id TEXT)`);
  db.run(`CREATE TABLE delegated_run_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, capability_id TEXT, task_id TEXT,
    project_id TEXT, initiator_person_id TEXT, initiator_device_id TEXT,
    execution_session_id TEXT, machine_id TEXT, repository_key TEXT, model TEXT,
    effort TEXT, max_duration_minutes INTEGER, max_attempts INTEGER, fanout INTEGER,
    phase TEXT, outcome TEXT, deadline_at INTEGER, created_at INTEGER, updated_at INTEGER)`);
  db.run(`CREATE TABLE delegated_node_authorizations (
    id TEXT PRIMARY KEY, capability_id TEXT, credential_hash TEXT,
    subject_person_id TEXT, subject_device_id TEXT, machine_id TEXT,
    repository_key TEXT, model TEXT, effort TEXT, max_duration_minutes INTEGER,
    max_attempts INTEGER, fanout INTEGER, authorized_by_person_id TEXT,
    authorized_at INTEGER, expires_at INTEGER, revoked_at INTEGER,
    revoked_by_person_id TEXT)`);
  db.run(`CREATE TABLE delegated_node_runs (
    run_id TEXT PRIMARY KEY, origin_task_id TEXT, project_id TEXT, capability_id TEXT,
    authorization_id TEXT, subject_person_id TEXT, subject_device_id TEXT, machine_id TEXT,
    repository_key TEXT, model TEXT, effort TEXT, max_duration_minutes INTEGER,
    max_attempts INTEGER, fanout INTEGER, expires_at INTEGER, revoked_at INTEGER,
    deadline_at INTEGER, created_at INTEGER)`);
  db.run("INSERT INTO people VALUES ('owner','Owner',NULL), ('person-a','Guest',NULL)");
  db.run("INSERT INTO devices VALUES ('device-a','Guest device','person-a',NULL)");
  db.run("INSERT INTO machines VALUES ('local','This computer',NULL), ('remote','Remote','https://node')");
  return db;
}

const base = {
  subjectType: "person" as const,
  subjectId: "person-a",
  projectId: "project-a",
  repositoryKey: "example.test/team/repo",
  model: "model-a",
  effort: "high",
  maxDurationMinutes: 30,
  grantedByPersonId: "owner",
  now: 100,
};

describe("delegated agent start capability", () => {
  test("the generated migration applies to a synthetic database", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    db.run("CREATE TABLE people (id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE devices (id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE machines (id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
    db.run(readFileSync(join(import.meta.dir, "../db/migrations/20260912115225-delegated-agent-start.sql"), "utf8"));
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegated_run_audit'").get())
      .toEqual({ name: "delegated_run_audit" });
    expect((db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name))
      .toContain("delegated_start_capability_id");
  });

  test("content principals resolve only their live project capability", () => {
    const db = database();
    putAgentStartCapability(db, { ...base, machineId: "local" });
    const principal = [{ kind: "person" as const, id: "person-a" }];
    expect(liveAgentStartCapability(db, { principals: principal, projectId: "project-a", now: 101 })?.model).toBe("model-a");
    expect(liveAgentStartCapability(db, { principals: principal, projectId: "project-b", now: 101 })).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM delegated_run_audit").get()).toEqual({ n: 0 });
  });

  test("remote authority is ineffective until the computer owner authorizes the repository", () => {
    const db = database();
    putAgentStartCapability(db, { ...base, machineId: "remote" });
    const query = () => liveAgentStartCapability(db, {
      principals: [{ kind: "person", id: "person-a" }], projectId: "project-a", now: 101,
    });
    expect(query()).toBeNull();
    db.run("INSERT INTO machine_repository_authorizations VALUES ('a','remote',?,'owner',100,NULL,NULL)", [base.repositoryKey]);
    expect(query()?.machineId).toBe("remote");
  });

  test("queue copies identity and policy once, and revocation fails closed on reload", () => {
    const db = database();
    const capability = putAgentStartCapability(db, { ...base, machineId: "local" });
    db.run("INSERT INTO tasks VALUES ('task-a','project-a','backlog',NULL,NULL,NULL,'',NULL,NULL,NULL)");
    queueDelegatedRun(db, {
      taskId: "task-a", capability, initiatorPersonId: "person-a", initiatorDeviceId: "device-a", now: 102,
    });
    const policy = delegatedPolicyForTask(db, "task-a", 103);
    expect(policy).toMatchObject({
      id: capability.id, taskId: "task-a", initiatorPersonId: "person-a",
      initiatorDeviceId: "device-a", maxAttempts: 1, fanout: 1,
    });
    expect(db.query("SELECT phase, model, effort, max_attempts, fanout FROM delegated_run_audit").get())
      .toEqual({ phase: "queued", model: "model-a", effort: "high", max_attempts: 1, fanout: 1 });
    expect(revokeAgentStartCapability(db, {
      capabilityId: capability.id, projectId: "project-a", revokedByPersonId: "owner", now: 104,
    })).toBe(true);
    expect(delegatedPolicyForTask(db, "task-a", 105)).toBeNull();
  });

  test("verified begin persists one absolute deadline and never renews it on resume", () => {
    const db = database();
    const capability = putAgentStartCapability(db, { ...base, machineId: "local" });
    db.run("INSERT INTO tasks VALUES ('task-a','project-a','backlog',NULL,NULL,NULL,'',NULL,NULL,NULL)");
    queueDelegatedRun(db, {
      taskId: "task-a", capability, initiatorPersonId: "person-a", initiatorDeviceId: "device-a", now: 102,
    });

    expect(appendDelegatedRunAudit(db, { taskId: "task-a", phase: "dispatch", now: 1_000 }))
      .toBe(1_801_000);
    expect(appendDelegatedRunAudit(db, { taskId: "task-a", phase: "resume", now: 90_000 }))
      .toBe(1_801_000);
    expect(db.query("SELECT phase, deadline_at FROM delegated_run_audit").get())
      .toEqual({ phase: "resume", deadline_at: 1_801_000 });
  });

  test("verified begin returns false after authority is revoked and leaves audit queued", () => {
    const db = database();
    const capability = putAgentStartCapability(db, { ...base, machineId: "local" });
    db.run("INSERT INTO tasks VALUES ('task-a','project-a','backlog',NULL,NULL,NULL,'',NULL,NULL,NULL)");
    queueDelegatedRun(db, {
      taskId: "task-a", capability, initiatorPersonId: "person-a", initiatorDeviceId: "device-a", now: 102,
    });
    revokeAgentStartCapability(db, {
      capabilityId: capability.id, projectId: "project-a", revokedByPersonId: "owner", now: 103,
    });

    expect(appendDelegatedRunAudit(db, { taskId: "task-a", phase: "dispatch", now: 104 })).toBe(false);
    expect(db.query("SELECT phase, deadline_at FROM delegated_run_audit").get())
      .toEqual({ phase: "queued", deadline_at: null });
  });

  test("dispatch revalidates the live device, person and recipient binding", () => {
    const db = database();
    const capability = putAgentStartCapability(db, { ...base, machineId: "local" });
    db.run("INSERT INTO tasks VALUES ('task-a','project-a','backlog',NULL,NULL,NULL,'',NULL,NULL,NULL)");
    queueDelegatedRun(db, {
      taskId: "task-a", capability, initiatorPersonId: "person-a", initiatorDeviceId: "device-a", now: 102,
    });
    expect(delegatedPolicyForTask(db, "task-a", 103)).not.toBeNull();
    db.run("UPDATE devices SET revoked_at = 104 WHERE id = 'device-a'");
    expect(delegatedPolicyForTask(db, "task-a", 105)).toBeNull();
    db.run("UPDATE devices SET revoked_at = NULL WHERE id = 'device-a'");
    db.run("UPDATE people SET revoked_at = 106 WHERE id = 'person-a'");
    expect(delegatedPolicyForTask(db, "task-a", 107)).toBeNull();
  });

  test("an organization capability stops at membership revocation", () => {
    const db = database();
    db.run("INSERT INTO orgs VALUES ('org-a',NULL)");
    db.run("INSERT INTO org_members VALUES ('org-a','person-a',NULL,NULL)");
    const capability = putAgentStartCapability(db, {
      ...base, subjectType: "org", subjectId: "org-a", machineId: "local",
    });
    db.run("INSERT INTO tasks VALUES ('task-a','project-a','backlog',NULL,NULL,NULL,'',NULL,NULL,NULL)");
    queueDelegatedRun(db, {
      taskId: "task-a", capability, initiatorPersonId: "person-a", initiatorDeviceId: "device-a", now: 102,
    });
    expect(delegatedPolicyForTask(db, "task-a", 103)).not.toBeNull();
    db.run("UPDATE org_members SET revoked_at = 104 WHERE org_id = 'org-a' AND person_id = 'person-a'");
    expect(delegatedPolicyForTask(db, "task-a", 105)).toBeNull();
  });

  test("normalizes repository identity independently of git transport", () => {
    expect(normalizeRepositoryKey("git@example.test:Team/Repo.git")).toBe("example.test/team/repo");
    expect(normalizeRepositoryKey("https://example.test/team/repo")).toBe("example.test/team/repo");
    expect(normalizeRepositoryKey("/local/path")).toBeNull();
  });
});
