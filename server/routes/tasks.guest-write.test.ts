/**
 * A guest's write capability on a shared task: `comment` and `edit` gate the
 * two writes this router opens to a guest at all (see
 * `matchGuestTaskAction`), and no level reaches a run, a stop, or any other
 * owner-only route (retitle, land, publish, ...).
 *
 * @covers GUEST-09, GUEST-11, GUEST-13, GUEST-14
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createTasksRouter, matchGuestTaskAction } from "./tasks";
import { putGrant, dropGrant } from "../lib/grants-query";
import { freshDb, makeCtx, call } from "./tasks-test-support";

const ROOT = join(import.meta.dir, "..", "..");

// The real chain, up to and including ours: 080 creates `devices`, 082/083
// bring `grants` from `task_shares`, 084 adds people/orgs, 20260816230500
// widens `resource_type` to `project`. Running the real predecessors instead
// of a hand-rolled schema is what `orgs.test.ts` already does — copied here
// so a future CHECK drifting from the TypeScript union fails a test, not a
// guest in production.
const MIGRATIONS = [
  "080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql",
  "20260816230500-grants-project.sql", "20260909180634-grant-levels-write-scope.sql",
];

function withGrants(db: Database): void {
  for (const m of MIGRATIONS) db.run(readFileSync(join(ROOT, "server/db/migrations", m), "utf8"));
}

function withAgentStart(db: Database): void {
  db.run("ALTER TABLE machines ADD COLUMN name TEXT");
  db.run("ALTER TABLE machines ADD COLUMN base_url TEXT");
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
  db.run(`CREATE TABLE delegated_run_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, capability_id TEXT, task_id TEXT,
    project_id TEXT, initiator_person_id TEXT, initiator_device_id TEXT,
    execution_session_id TEXT, machine_id TEXT, repository_key TEXT, model TEXT,
    effort TEXT, max_duration_minutes INTEGER, max_attempts INTEGER, fanout INTEGER,
    phase TEXT, outcome TEXT, created_at INTEGER, updated_at INTEGER)`);
}

function guestCtx(db: Database, broadcasts: unknown[], deviceId: string) {
  const base = makeCtx(db, broadcasts);
  return { ...base, requestIdentity: () => ({ role: "guest" as const, deviceId }) } as unknown as AppContext;
}

describe("matchGuestTaskAction - the two guest writes, and nothing else", () => {
  test("read on the item itself, and only the item", () => {
    expect(matchGuestTaskAction("/api/tasks/t1", "t1", "GET")).toBe("read");
    expect(matchGuestTaskAction("/api/tasks/t1/comments", "t1", "GET")).toBe("unsupported");
  });
  test("comment and edit, each its own subpath", () => {
    expect(matchGuestTaskAction("/api/tasks/t1/comments", "t1", "POST")).toBe("comment");
    expect(matchGuestTaskAction("/api/tasks/t1", "t1", "PATCH")).toBe("edit");
  });
  test("run uses a separate capability while stop remains unsupported", () => {
    expect(matchGuestTaskAction("/api/tasks/t1/run", "t1", "POST")).toBe("run");
    expect(matchGuestTaskAction("/api/tasks/t1/stop", "t1", "POST")).toBe("unsupported");
  });
  test("everything else on this router is unsupported for a guest, at any level", () => {
    expect(matchGuestTaskAction("/api/tasks/t1/land", "t1", "POST")).toBe("unsupported");
    expect(matchGuestTaskAction("/api/tasks/t1/retitle", "t1", "POST")).toBe("unsupported");
    expect(matchGuestTaskAction("/api/tasks/t1", "t1", "DELETE")).toBe("unsupported");
  });
});

describe("a guest with a level on a shared task", () => {
  let db: Database; let broadcasts: any[]; let owner: any; let taskId: string;
  beforeEach(async () => {
    db = freshDb(); broadcasts = [];
    withGrants(db);
    owner = createTasksRouter(makeCtx(db, broadcasts));
    const t = await (await call(owner, "POST", "/api/sessions/s1/tasks", { text: "shared card" }))!.json();
    taskId = t.id;
  });

  test("`read` only: sees the task, cannot comment", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "read", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const got = await (await call(guest, "GET", `/api/tasks/${taskId}`))!.json();
    expect(got.id).toBe(taskId);
    const denied = (await call(guest, "POST", `/api/tasks/${taskId}/comments`, { content: "hi" }))!;
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("guest_level_denied");
  });

  test("`comment`: can comment, cannot edit the text", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "comment", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const posted = (await call(guest, "POST", `/api/tasks/${taskId}/comments`, { content: "looks good" }))!;
    expect(posted.status).toBe(200);
    expect(broadcasts.some((b) => b.type === "task:updated")).toBe(true);
    const denied = (await call(guest, "PATCH", `/api/tasks/${taskId}`, { text: "renamed" }))!;
    expect(denied.status).toBe(403);
  });

  test("`edit`: can rename the card, and STILL cannot start it", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "edit", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const edited = (await call(guest, "PATCH", `/api/tasks/${taskId}`, { text: "renamed by guest" }))!;
    expect(edited.status).toBe(200);
    expect((await edited.json()).text).toBe("renamed by guest");
    // The pair that made `run` unacceptable: rewrite the text, then dispatch it
    // as a prompt inside the owner's repository. The second half is refused at
    // the TOP level of the scale, so the pair cannot be assembled at all.
    for (const route of ["run", "stop"]) {
      const denied = (await call(guest, "POST", `/api/tasks/${taskId}/${route}`))!;
      expect(denied.status).toBe(403);
      expect((await denied.json()).code).toBe(route === "run" ? "agent_start_denied" : "guest_read_only");
    }
    // And nothing was dispatched: the card is still where the edit left it.
    expect(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId)).toMatchObject({ status: "backlog" });
  });

  test("a guest cannot select model, effort, machine, prompt or status", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "read", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    for (const field of ["model", "effort", "machine", "prompt", "status"]) {
      const denied = (await call(guest, "POST", `/api/tasks/${taskId}/run`, { [field]: "chosen" }))!;
      expect(denied.status, field).toBe(400);
      expect((await denied.json()).code).toBe("guest_run_body_not_empty");
    }
    expect(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId)).toMatchObject({ status: "backlog" });
  });

  test("an empty request queues exactly one attempt with the owner policy", async () => {
    withAgentStart(db);
    db.run("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('person-a','Guest',1,'local',1,1)");
    db.run("INSERT INTO devices (id, name, token_hash, created_at, role, person_id) VALUES ('g1','Guest device','hash',1,'guest','person-a')");
    db.run("INSERT INTO machines (id, name, base_url) VALUES ('local','This computer',NULL)");
    putGrant(db, { kind: "person", id: "person-a" }, "task", taskId, { level: "read", grantedAt: 1 });
    db.run(`INSERT INTO agent_start_capabilities
      VALUES ('cap-a','person','person-a',?,'local','example.test/team/repo','model-a','high',30,1,1,'owner',1,NULL,NULL,NULL)`,
      [(db.query("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as { project_id: string }).project_id]);
    let queued = 0;
    const dispatcher = { onEnterTodo: () => { queued++; } } as any;
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"), dispatcher);
    const accepted = (await call(guest, "POST", `/api/tasks/${taskId}/run`))!;
    expect(accepted.status).toBe(202);
    expect(queued).toBe(1);
    expect(db.query("SELECT status, delegated_start_capability_id, model, model_effort FROM tasks WHERE id = ?").get(taskId))
      .toEqual({ status: "todo", delegated_start_capability_id: "cap-a", model: "model-a", model_effort: "high" });
    expect(db.query("SELECT COUNT(*) AS n FROM delegated_run_audit WHERE task_id = ?").get(taskId)).toEqual({ n: 1 });
    const duplicate = (await call(guest, "POST", `/api/tasks/${taskId}/run`))!;
    expect(duplicate.status).toBe(409);
    expect(queued).toBe(1);
  });

  test("`edit` still cannot reach an owner-only route", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "edit", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const denied = (await call(guest, "POST", `/api/tasks/${taskId}/land`))!;
    expect(denied.status).toBe(403);
  });

  test("un `edit` sul PROGETTO non diventa un `edit` sulle sue schede", async () => {
    // The chain this crosses is the one that matters: the router asks
    // `levelFor`, which falls back to the container when the card carries no
    // row of its own. Uncapped, ONE click on the project handed a guest the
    // text of every card it holds - and that text becomes the prompt of an
    // agent running in the owner's repository at the next dispatch.
    const projectId = (db.query("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as { project_id: string }).project_id;
    putGrant(db, { kind: "device", id: "g1" }, "project", projectId, { level: "edit", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));

    // Reading still works: the container opens the door, and taking that away
    // would break sharing a project at all.
    expect((await call(guest, "GET", `/api/tasks/${taskId}`))!.status).toBe(200);

    for (const [method, path, body] of [
      ["POST", `/api/tasks/${taskId}/comments`, { content: "hi" }],
      ["PATCH", `/api/tasks/${taskId}`, { text: "riscritta dall'ospite" }],
    ] as const) {
      const denied = (await call(guest, method, path, body))!;
      expect(denied.status, `${method} ${path}`).toBe(403);
      expect((await denied.json()).code).toBe("guest_level_denied");
    }
    // And the text on disk is the one the owner wrote.
    expect(db.query("SELECT text FROM tasks WHERE id = ?").get(taskId)).toMatchObject({ text: "shared card" });
  });

  test("a `deny` beats any level, including the ones granted to the guest's own device", async () => {
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "edit", grantedAt: Date.now() });
    // A level change is drop-then-put, same as the sharing UI does — the
    // UNIQUE(subject, resource) index would otherwise silently ignore the
    // second row.
    dropGrant(db, { kind: "device", id: "g1" }, "task", taskId);
    putGrant(db, { kind: "device", id: "g1" }, "task", taskId, { level: "deny", grantedAt: Date.now() });
    const guest = createTasksRouter(guestCtx(db, broadcasts, "g1"));
    const denied = (await call(guest, "GET", `/api/tasks/${taskId}`))!;
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("not_shared");
  });
});
