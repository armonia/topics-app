/**
 * Verifica che `stampDeliveryBranch` (chiamata dal GC su free-checkout) NON
 * azzeri commit, diffstat e landing_state di una card che li aveva gia'.
 *
 * Il difetto era in `worktree-gc-runner.ts`: lo stamp passava da
 * `recordDelivery({ commit: null })`, che per progetto riscrive anche commit e
 * diffstat a NULL e azzera landing_state. Le card dichiarate NON su main dal GC
 * stesso perdevano per sempre i numeri che descrivevano il loro lavoro, e
 * uscivano dall'audit (`listLandingAuditCandidates` filtra per
 * `delivery_commit IS NOT NULL`).
 *
 * Soluzione: `setDeliveryBranch(taskId, branch)` scrive SOLO `delivery_branch`.
 *
 * @covers WORKTREE-10
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_FK_STUBS_DDL);
  db.run(TASKS_DDL);
  db.run(TASK_LABELS_DDL);
  return db;
}

function makeTask(db: Database, projectId = "p1") {
  const svc = createTaskService(db);
  return svc.create({
    projectId,
    text: "Task di prova",
    status: "todo",
  });
}

describe("setDeliveryBranch — non azzera commit/diffstat/landing_state", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("dopo setDeliveryBranch il delivery_commit originale e' ancora presente", () => {
    const svc = createTaskService(db);
    const task = makeTask(db);

    // Simuliamo la consegna completa: branch + commit + diffstat + landing_state
    svc.recordDelivery({
      taskId: task.id,
      branch: "topics/original-branch",
      commit: "abc123def456",
      stat: { filesChanged: 7, insertions: 240, deletions: 18 },
    });

    // Il GC vuole solo aggiornare il delivery_branch (perche' la cartella
    // sta per sparire), senza toccare il resto.
    svc.setDeliveryBranch(task.id, "topics/original-branch");

    const after = db.prepare(
      "SELECT delivery_commit, delivery_files_changed, delivery_insertions, delivery_deletions FROM tasks WHERE id = ?",
    ).get(task.id) as any;
    expect(after.delivery_commit).toBe("abc123def456");
    expect(after.delivery_files_changed).toBe(7);
    expect(after.delivery_insertions).toBe(240);
    expect(after.delivery_deletions).toBe(18);
  });

  test("dopo setDeliveryBranch il delivery_branch viene aggiornato", () => {
    const svc = createTaskService(db);
    const task = makeTask(db);

    svc.recordDelivery({
      taskId: task.id,
      branch: "topics/old-branch",
      commit: "abc123",
      stat: null,
    });

    svc.setDeliveryBranch(task.id, "topics/new-branch");

    const after = db.prepare("SELECT delivery_branch FROM tasks WHERE id = ?").get(task.id) as any;
    expect(after.delivery_branch).toBe("topics/new-branch");
  });

  test("dopo setDeliveryBranch il landing_state NON viene azzerato", () => {
    const svc = createTaskService(db);
    const task = makeTask(db);

    svc.recordDelivery({
      taskId: task.id,
      branch: "topics/branch",
      commit: "abc123",
      stat: { filesChanged: 3, insertions: 10, deletions: 2 },
    });

    // Scriviamo un landing_state (direttamente in DB, come fa il GC dopo la passata)
    db.run(
      "UPDATE tasks SET landing_state = 'unlanded', landing_checked_at = ? WHERE id = ?",
      [Date.now(), task.id],
    );

    // Il GC chiama lo stamp
    svc.setDeliveryBranch(task.id, "topics/branch");

    const row = db.prepare("SELECT landing_state FROM tasks WHERE id = ?").get(task.id) as any;
    expect(row.landing_state).toBe("unlanded");
  });

  test("la card resta nell'audit (delivery_commit IS NOT NULL) dopo lo stamp del GC", () => {
    const svc = createTaskService(db);
    const task = makeTask(db);

    // Portiamo in review con SQL diretto (l'API richiederebbe un turno attivo)
    db.run("UPDATE tasks SET status = 'review' WHERE id = ?", [task.id]);

    svc.recordDelivery({
      taskId: task.id,
      branch: "topics/branch",
      commit: "abc123",
      stat: { filesChanged: 5, insertions: 100, deletions: 50 },
    });

    // GC: libera la cartella, timbra solo il ramo
    svc.setDeliveryBranch(task.id, "topics/branch");

    const candidates = svc.listLandingAuditCandidates();
    expect(candidates.some((c) => c.id === task.id)).toBe(true);
  });

  test("ROSSO (prima del fix): recordDelivery con commit=null azzera il commit esistente", () => {
    // Questo test documenta il comportamento PRIMA del fix.
    // Se un giorno recordDelivery venisse reso non-distruttivo, questo test
    // andrebbe aggiornato. Per ora, la prova che il difetto esisteva.
    const svc = createTaskService(db);
    const task = makeTask(db);

    svc.recordDelivery({
      taskId: task.id,
      branch: "topics/branch",
      commit: "abc123",
      stat: { filesChanged: 7, insertions: 240, deletions: 18 },
    });

    // Comportamento vecchio: recordDelivery con commit: null azzera il commit
    svc.recordDelivery({
      taskId: task.id,
      branch: "topics/branch",
      commit: null,
    });

    const after = db.prepare("SELECT delivery_commit FROM tasks WHERE id = ?").get(task.id) as any;
    // Questo era il bug: deliveryCommit diventa null
    expect(after.delivery_commit).toBeNull();
  });
});
