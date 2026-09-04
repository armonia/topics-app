/**
 * Il goal di una chat (3.4). Quello che conta qui non è il CRUD — è che le due
 * cose che rendono un goal affidabile restino vere: che ce ne sia UNO solo
 * attivo per topic (imposto dal DB, non dal codice) e che i passi si
 * sostituiscano in blocco senza che nessun lettore veda mezzo piano.
 * @covers CTX-GOAL-01
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import {
  closeGoal,
  getActiveGoal,
  getGoal,
  goalContextContent,
  listGoals,
  reopenGoal,
  replaceSteps,
  setGoal,
  setGoalLoop,
} from "./goals";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  // FK ON: la CASCADE su topics è metà del punto della migration, un test che
  // gira con le foreign key spente non proverebbe niente.
  db.run("PRAGMA foreign_keys = ON");
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY)");
  db.run(readFileSync(join(import.meta.dir, "..", "db", "migrations", "064-topic-goals.sql"), "utf-8"));
  // The loop columns arrive with a LATER migration, and this bench applies the
  // real files rather than a hand-written schema: a copy here would be a second
  // definition of the table, free to drift from the one that ships.
  db.run(readFileSync(
    join(import.meta.dir, "..", "db", "migrations", "20260903232650-goal-continuazione.sql"), "utf-8",
  ));
  db.run("INSERT INTO topics (id) VALUES ('t1'), ('t2')");
});

describe("un solo goal attivo per topic", () => {
  test("dichiararne uno nuovo abbandona il precedente", () => {
    const first = setGoal(db, { topicId: "t1", content: "Sistemare il login" });
    const second = setGoal(db, { topicId: "t1", content: "Sistemare il logout" });

    expect(getActiveGoal(db, "t1")!.id).toBe(second.id);
    const old = getGoal(db, first.id)!;
    expect(old.status).toBe("abandoned");
    expect(old.closedAt).not.toBeNull();
    expect(listGoals(db, "t1").length).toBe(2);
  });

  test("l'invariante la impone il DB, non il servizio", () => {
    setGoal(db, { topicId: "t1", content: "A" });
    // Scavalcando il servizio: l'indice parziale unico deve rifiutare.
    expect(() =>
      db
        .prepare(
          `INSERT INTO topic_goals (id, topic_id, content, status, created_by, created_at)
           VALUES ('x', 't1', 'B', 'active', 'human', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
  });

  test("topic diverse non si disturbano", () => {
    setGoal(db, { topicId: "t1", content: "A" });
    setGoal(db, { topicId: "t2", content: "B" });
    expect(getActiveGoal(db, "t1")!.content).toBe("A");
    expect(getActiveGoal(db, "t2")!.content).toBe("B");
  });

  test("un contenuto vuoto è un errore, non un modo per cancellare", () => {
    expect(() => setGoal(db, { topicId: "t1", content: "   " })).toThrow("goal_content_required");
    expect(getActiveGoal(db, "t1")).toBeNull();
  });

  test("il contenuto si normalizza, createdBy si registra", () => {
    const g = setGoal(db, { topicId: "t1", content: "  Con spazi  ", createdBy: "agent" });
    expect(g.content).toBe("Con spazi");
    expect(g.createdBy).toBe("agent");
    expect(setGoal(db, { topicId: "t2", content: "x" }).createdBy).toBe("human");
  });
});

describe("chiusura e riapertura", () => {
  test("achieved e abandoned sono due esiti diversi, entrambi finali", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    const closed = closeGoal(db, g.id, "achieved")!;
    expect(closed.status).toBe("achieved");
    expect(closed.closedAt).not.toBeNull();
    expect(getActiveGoal(db, "t1")).toBeNull();
  });

  test("chiudere due volte non riscrive la storia", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    const first = closeGoal(db, g.id, "achieved")!;
    const second = closeGoal(db, g.id, "abandoned")!;
    expect(second.status).toBe("achieved");
    expect(second.closedAt).toBe(first.closedAt);
  });

  test("un goal che non esiste torna null, non esplode", () => {
    expect(closeGoal(db, "mai-visto", "achieved")).toBeNull();
    expect(reopenGoal(db, "mai-visto")).toBeNull();
    expect(getGoal(db, "mai-visto")).toBeNull();
  });

  test("riaprire abbandona quello attivo: l'invariante regge anche all'indietro", () => {
    const vecchio = setGoal(db, { topicId: "t1", content: "Vecchio" });
    closeGoal(db, vecchio.id, "abandoned");
    const nuovo = setGoal(db, { topicId: "t1", content: "Nuovo" });

    const riaperto = reopenGoal(db, vecchio.id)!;
    expect(riaperto.status).toBe("active");
    expect(riaperto.closedAt).toBeNull();
    expect(getGoal(db, nuovo.id)!.status).toBe("abandoned");
    expect(getActiveGoal(db, "t1")!.id).toBe(vecchio.id);
  });

  test("riaprire un goal già attivo è un no-op", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    expect(reopenGoal(db, g.id)!.id).toBe(g.id);
    expect(getActiveGoal(db, "t1")!.id).toBe(g.id);
  });
});

describe("passi: sostituzione in blocco", () => {
  test("l'elenco si sostituisce, non si accumula", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    replaceSteps(db, g.id, [{ content: "uno" }, { content: "due" }]);
    replaceSteps(db, g.id, [{ content: "solo questo", status: "completed" }]);

    const steps = getActiveGoal(db, "t1")!.steps;
    expect(steps.map((s) => s.content)).toEqual(["solo questo"]);
    expect(steps[0]!.status).toBe("completed");
  });

  test("l'ordine è la posizione, non l'id", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    replaceSteps(db, g.id, [{ content: "a" }, { content: "b" }, { content: "c" }]);
    const steps = getGoal(db, g.id)!.steps;
    expect(steps.map((s) => s.content)).toEqual(["a", "b", "c"]);
    expect(steps.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  test("voci vuote e stati sconosciuti non arrivano nella UI", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    const steps = replaceSteps(db, g.id, [
      { content: "  " },
      { content: "vero", status: "boh" },
      { content: "" },
    ]);
    expect(steps.length).toBe(1);
    expect(steps[0]!.status).toBe("pending");
  });

  test("svuotare è legittimo", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    replaceSteps(db, g.id, [{ content: "uno" }]);
    expect(replaceSteps(db, g.id, [])).toEqual([]);
    expect(getGoal(db, g.id)!.steps).toEqual([]);
  });

  test("i passi seguono il loro goal quando la topic sparisce", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    replaceSteps(db, g.id, [{ content: "uno" }]);
    db.prepare("DELETE FROM topics WHERE id = 't1'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM topic_goals").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM topic_goal_steps").get()).toEqual({ c: 0 });
  });

  test("listGoals non mescola i passi fra goal diversi", () => {
    const primo = setGoal(db, { topicId: "t1", content: "A" });
    replaceSteps(db, primo.id, [{ content: "a1" }]);
    const secondo = setGoal(db, { topicId: "t1", content: "B" });
    replaceSteps(db, secondo.id, [{ content: "b1" }, { content: "b2" }]);

    const byId = new Map(listGoals(db, "t1").map((g) => [g.id, g]));
    expect(byId.get(primo.id)!.steps.map((s) => s.content)).toEqual(["a1"]);
    expect(byId.get(secondo.id)!.steps.map((s) => s.content)).toEqual(["b1", "b2"]);
  });
});

describe("lo stato del ciclo di auto-continuazione", () => {
  test("nasce fermo a zero e in corsa: un goal nuovo non eredita niente", () => {
    const g = setGoal(db, { topicId: "t1", content: "arrivare in fondo" });
    expect(g.continuations).toBe(0);
    expect(g.idleTurns).toBe(0);
    expect(g.loopState).toBe("running");
  });

  test("i contatori si scrivono uno per volta, gli altri restano dove sono", () => {
    const g = setGoal(db, { topicId: "t1", content: "arrivare in fondo" });
    setGoalLoop(db, g.id, { continuations: 3 });
    const after = setGoalLoop(db, g.id, { state: "blocked" })!;
    expect(after.continuations).toBe(3);
    expect(after.loopState).toBe("blocked");
  });

  test("un goal chiuso non si tocca: il suo ciclo è finito per definizione", () => {
    const g = setGoal(db, { topicId: "t1", content: "arrivare in fondo" });
    closeGoal(db, g.id, "achieved");
    const after = setGoalLoop(db, g.id, { continuations: 9, state: "running" })!;
    expect(after.continuations).toBe(0);
    expect(after.status).toBe("achieved");
  });

  test("il goal che si è dato l'agente ha lo stesso ciclo, e lo stesso tetto", () => {
    // The continuation loop reads the ACTIVE goal, whoever wrote it. This is
    // the assertion that keeps `set_goal` from producing a second-class goal:
    // one the bar shows but nobody carries on by itself.
    const g = setGoal(db, { topicId: "t1", content: "portare a termine il refactor", createdBy: "agent" });
    expect(getActiveGoal(db, "t1")!.id).toBe(g.id);
    const after = setGoalLoop(db, g.id, { continuations: 4, state: "running" })!;
    expect(after.createdBy).toBe("agent");
    expect(after.continuations).toBe(4);
  });

  test("riaprire riparte da zero: il tetto speso apparteneva al giro finito", () => {
    const g = setGoal(db, { topicId: "t1", content: "arrivare in fondo" });
    setGoalLoop(db, g.id, { continuations: 7, idleTurns: 1, state: "stopped" });
    closeGoal(db, g.id, "abandoned");
    const riaperto = reopenGoal(db, g.id)!;
    expect(riaperto.continuations).toBe(0);
    expect(riaperto.idleTurns).toBe(0);
    expect(riaperto.loopState).toBe("running");
  });
});

describe("il testo che finisce nel contesto", () => {
  test("niente goal, niente blocco", () => {
    expect(goalContextContent(null)).toBeNull();
  });

  test("un goal chiuso non si inietta più", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    closeGoal(db, g.id, "achieved");
    expect(goalContextContent(getGoal(db, g.id))).toBeNull();
  });

  test("senza passi è una riga sola più il richiamo", () => {
    const g = setGoal(db, { topicId: "t1", content: "Sistemare il login" });
    const text = goalContextContent(g)!;
    expect(text).toContain("Obiettivo di questa conversazione: Sistemare il login");
    expect(text).not.toContain("Piano dichiarato");
    expect(text).toContain("Resta su questo obiettivo");
  });

  test("i passi si vedono con lo stato, in ordine", () => {
    const g = setGoal(db, { topicId: "t1", content: "A" });
    replaceSteps(db, g.id, [
      { content: "fatto", status: "completed" },
      { content: "in corso", status: "in_progress" },
      { content: "da fare", status: "pending" },
    ]);
    const text = goalContextContent(getActiveGoal(db, "t1"))!;
    expect(text).toContain("[x] fatto");
    expect(text).toContain("[~] in corso");
    expect(text).toContain("[ ] da fare");
    expect(text.indexOf("fatto")).toBeLessThan(text.indexOf("in corso"));
  });
});
