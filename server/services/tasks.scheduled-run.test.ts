/**
 * A SCHEDULED CARD IS NEVER CLAIMED BY AN AGENT.
 *
 * The work of a card tied to a timed run (a mail, a call to a client) is done
 * by that run. If the dispatcher claimed it, an agent would do the same work
 * again, and a duplicate sent to a real person cannot be undone. Proven at the
 * critical point: the claim CAS and the queue (`rankQueue`, read as "how many
 * are ahead of me").
 */
import { test, expect, describe, beforeEach, beforeAll, afterAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { freshDb as schemaDb } from "./tasks-test-db";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";

const STATE_ROOT = testTmpDir("tasks-scheduled-run");
beforeAll(() => setupTestDataDir(`${STATE_ROOT}/data`));
afterAll(() => cleanupTestDataDir(STATE_ROOT));

const PID = "topics-app-abc123";
const AT = "2026-11-12T09:00:00.000Z";

let clock = 0;
function svc(db: Database): TaskService {
  let n = 0;
  return createTaskService(db, {
    now: () => new Date(Date.UTC(2026, 10, 11, 9, clock++)).toISOString(),
    uuid: () => `id-${++n}`,
  });
}

function toTodo(s: TaskService, taskId: string) {
  return s.update({ taskId, actor: "human", by: "mario", patch: { status: "todo" } });
}

describe("card programmata: fuori dalla coda del dispatcher", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => {
    clock = 0;
    db = schemaDb();
    db.run("UPDATE app_settings SET auto_dispatch = 1");
    s = svc(db);
  });

  test("il claim rifiuta una card programmata in todo", () => {
    const t = s.create({ projectId: PID, text: "Mail al cliente finto" });
    toTodo(s, t.id);
    s.update({ taskId: t.id, actor: "human", by: "mario", patch: { scheduled: { by: "Jarvis", at: AT } } });
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 3 })).toBeNull();
    expect(s.get(t.id)!.task.status).toBe("todo");
  });

  test("tolta la programmazione, la stessa card torna reclamabile", () => {
    const t = s.create({ projectId: PID, text: "Mail al cliente finto" });
    toTodo(s, t.id);
    s.update({ taskId: t.id, actor: "human", by: "mario", patch: { scheduled: { by: "Jarvis", at: AT } } });
    s.update({ taskId: t.id, actor: "human", by: "mario", patch: { scheduled: null } });
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 3 })?.status).toBe("in_progress");
  });

  test("una card programmata non conta nella fila e non ha frase di coda", () => {
    const programmata = s.create({ projectId: PID, text: "Giro a orario", priority: 4 });
    const normale = s.create({ projectId: PID, text: "Lavoro da agente" });
    toTodo(s, programmata.id);
    toTodo(s, normale.id);
    s.update({ taskId: programmata.id, actor: "human", by: "mario", patch: { scheduled: { by: "Jarvis", at: AT } } });
    const reason = s.get(normale.id)!.task.queueReason;
    expect(reason?.kind).toBe("slot");
    expect(reason?.params?.ahead ?? 0).toBe(0);
    expect(s.get(programmata.id)!.task.queueReason).toBeNull();
  });

  test("il payload porta chi e quando", () => {
    const t = s.create({ projectId: PID, text: "Giro a orario" });
    s.update({ taskId: t.id, actor: "human", by: "mario", patch: { scheduled: { by: "Jarvis", at: AT } } });
    expect(s.get(t.id)!.task.scheduled).toEqual({ by: "Jarvis", at: AT });
  });
});
