/**
 * @covers KANBAN-14
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { createTaskAttemptStore, type TaskAttemptStore } from "./task-attempts";
import { TASKS_DDL, TASKS_FK_STUBS_DDL } from "../db/test-schema";

// Lo schema vero, letto dalla migration: se qualcuno cambia 065 e non questo
// modulo, il test si rompe qui invece che in produzione. (La DDL a mano di
// tasks.test.ts esiste perché quel servizio tocca mezza migration 001; qui la
// superficie è una tabella sola, quindi non c'è scusa per copiarla.)
const MIGRATION = join(import.meta.dir, "../db/migrations/065-task-fanout.sql");

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  // La migration fa anche ALTER su board_settings: serve che la tabella esista.
  db.run("CREATE TABLE board_settings (project_id TEXT PRIMARY KEY)");
  db.run(readFileSync(MIGRATION, "utf-8"));
  db.run("INSERT INTO tasks (id, project_id, text, created_at, updated_at) VALUES ('t1', 'p-test', 'x', '2026-01-01', '2026-01-01'), ('t2', 'p-test', 'x', '2026-01-01', '2026-01-01')");
  return db;
}

describe("task-attempts store", () => {
  let db: Database;
  let store: TaskAttemptStore;
  beforeEach(() => {
    db = freshDb();
    store = createTaskAttemptStore(db);
  });

  test("create → running, con gli id e l'indice che l'umano legge", () => {
    const a = store.create({ taskId: "t1", idx: 1, model: "claude-opus-4-8" });
    expect(a.taskId).toBe("t1");
    expect(a.idx).toBe(1);
    expect(a.state).toBe("running");
    expect(a.model).toBe("claude-opus-4-8");
    expect(a.topicId).toBeNull();
    expect(a.worktreeId).toBeNull();
    expect(a.commit).toBeNull();
    expect(a.agentMs).toBe(0);
    expect(a.createdAt).toBeTruthy();
    expect(store.get(a.id)).toEqual(a);
  });

  test("list è per task e ordinata per idx, non per ordine di inserimento", () => {
    store.create({ taskId: "t1", idx: 3 });
    store.create({ taskId: "t1", idx: 1 });
    store.create({ taskId: "t2", idx: 1 });
    expect(store.list("t1").map((a) => a.idx)).toEqual([1, 3]);
    expect(store.list("t2").map((a) => a.idx)).toEqual([1]);
    expect(store.list("ignoto")).toEqual([]);
  });

  test("due tentativi con lo stesso idx sullo stesso task non esistono", () => {
    store.create({ taskId: "t1", idx: 1 });
    expect(() => store.create({ taskId: "t1", idx: 1 })).toThrow();
    // ...ma lo stesso idx su un ALTRO task è legittimo: "tentativo 1" è
    // un'etichetta per-task, non un identificatore globale.
    expect(() => store.create({ taskId: "t2", idx: 1 })).not.toThrow();
  });

  test("bind riempie ciò che si sa solo dopo il setup, e non azzera il resto", () => {
    const a = store.create({ taskId: "t1", idx: 1, model: "m" });
    const bound = store.bind(a.id, { topicId: "topic-9", worktreeId: "wt-9", branch: "task/x-1" })!;
    expect(bound.topicId).toBe("topic-9");
    expect(bound.worktreeId).toBe("wt-9");
    expect(bound.branch).toBe("task/x-1");
    expect(bound.model).toBe("m"); // non toccato = non perso
    expect(bound.state).toBe("running");
    // Una bind vuota è un no-op, non una UPDATE senza SET (che sarebbe SQL rotto).
    expect(store.bind(a.id, {})).toEqual(bound);
  });

  test("finish fotografa l'esito: stato, commit, diffstat, prosa, costo", () => {
    const a = store.create({ taskId: "t1", idx: 1 });
    const done = store.finish(a.id, {
      state: "delivered",
      commit: "abc1234",
      filesChanged: 3,
      insertions: 120,
      deletions: 8,
      summary: "Aggiunto il gate",
      agentMs: 4200,
      agentTokens: 90_000,
    })!;
    expect(done.state).toBe("delivered");
    expect(done.commit).toBe("abc1234");
    expect(done.filesChanged).toBe(3);
    expect(done.insertions).toBe(120);
    expect(done.deletions).toBe(8);
    expect(done.summary).toBe("Aggiunto il gate");
    expect(done.agentMs).toBe(4200);
    expect(done.agentTokens).toBe(90_000);
    expect(done.endedAt).toBeTruthy();
  });

  test("runningCount conta solo i turni vivi", () => {
    const a = store.create({ taskId: "t1", idx: 1 });
    store.create({ taskId: "t1", idx: 2 });
    store.create({ taskId: "t2", idx: 1 });
    expect(store.runningCount("t1")).toBe(2);
    store.finish(a.id, { state: "failed", error: "boom" });
    expect(store.runningCount("t1")).toBe(1);
    expect(store.runningCount("t2")).toBe(1);
  });

  test("select promuove uno e scarta TUTTI gli altri, in un colpo solo", () => {
    const a1 = store.create({ taskId: "t1", idx: 1 });
    const a2 = store.create({ taskId: "t1", idx: 2 });
    const a3 = store.create({ taskId: "t1", idx: 3 });
    store.finish(a1.id, { state: "delivered", commit: "aaa", filesChanged: 1 });
    store.finish(a2.id, { state: "delivered", commit: "bbb", filesChanged: 2 });
    store.finish(a3.id, { state: "failed", error: "morto" });

    const res = store.select("t1", a2.id)!;
    expect(res.winner.id).toBe(a2.id);
    expect(res.winner.state).toBe("selected");
    expect(res.winner.selectedAt).toBeTruthy();
    // I perdenti tornano a chi chiama perché è lui a doverne reapare i worktree.
    expect(res.losers.map((l) => l.id).sort()).toEqual([a1.id, a3.id].sort());
    expect(res.losers.every((l) => l.state === "discarded")).toBe(true);
    // E la fotografia del vincitore non è stata toccata dalla promozione.
    expect(res.winner.commit).toBe("bbb");
  });

  test("un secondo select ribalta la scelta senza mai lasciare due vincitori", () => {
    const a1 = store.create({ taskId: "t1", idx: 1 });
    const a2 = store.create({ taskId: "t1", idx: 2 });
    store.select("t1", a1.id);
    store.select("t1", a2.id);
    const states = store.list("t1").map((a) => a.state);
    expect(states.filter((s) => s === "selected").length).toBe(1);
    expect(store.get(a2.id)!.state).toBe("selected");
    expect(store.get(a1.id)!.state).toBe("discarded");
  });

  test("select rifiuta un id che non è di quel task", () => {
    const a = store.create({ taskId: "t1", idx: 1 });
    expect(store.select("t2", a.id)).toBeNull();
    expect(store.select("t1", "inesistente")).toBeNull();
    expect(store.get(a.id)!.state).toBe("running"); // niente danni collaterali
  });

  test("un turno zombie che finisce DOPO la scelta non riscrive l'esito", () => {
    const a1 = store.create({ taskId: "t1", idx: 1 });
    const a2 = store.create({ taskId: "t1", idx: 2 });
    store.select("t1", a1.id);
    // a2 era ancora vivo: il suo turno atterra adesso. Deve restare 'discarded',
    // altrimenti il fan-out si riaprirebbe dopo che l'umano ha già deciso.
    const late = store.finish(a2.id, { state: "delivered", commit: "zzz", filesChanged: 9 })!;
    expect(late.state).toBe("discarded");
    expect(late.commit).toBeNull();
    // E nemmeno il vincitore può essere "finito" una seconda volta.
    expect(store.finish(a1.id, { state: "failed", error: "tardi" })!.state).toBe("selected");
  });

  test("clear svuota solo il task chiesto; il DELETE del task fa cascade", () => {
    store.create({ taskId: "t1", idx: 1 });
    store.create({ taskId: "t2", idx: 1 });
    store.clear("t1");
    expect(store.list("t1")).toEqual([]);
    expect(store.list("t2").length).toBe(1);

    db.run("DELETE FROM tasks WHERE id = 't2'");
    expect(store.list("t2")).toEqual([]);
  });
});
