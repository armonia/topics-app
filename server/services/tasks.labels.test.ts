/**
 * Il cancello che rende le etichette qualcosa di più di una decorazione.
 *
 * `invisibile` decide che la card la può chiudere il conduttore senza che un
 * umano la guardi. Se un agente potesse scriversela da sé, l'etichetta non
 * sarebbe una misura di ciò che si vede: sarebbe il modulo con cui si autorizza
 * a chiudersi le proprie card. Da qui l'asimmetria: alzare la mano sempre,
 * abbassarla mai — e nemmeno di sponda, togliendo un `visibile` già scritto.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, TaskServiceError, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { freshDb } from "./tasks-test-db";


const PID = "topics-app-abc123";

function svc(db: Database): TaskService {
  let n = 0;
  return createTaskService(db, { now: () => "2026-08-11T18:00:00.000Z", uuid: () => `id-${++n}` });
}

describe("l'agente non si marca invisibile da solo", () => {
  let db: Database; let s: TaskService; let taskId: string;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    taskId = s.create({ projectId: PID, text: "Riscrittura del dispatcher" }).id;
  });

  test("RIFIUTATO: un agente che si scrive `invisibile` prende label_forbidden", () => {
    let err: unknown;
    try {
      s.setLabels({ taskId, labels: ["invisibile", "chore"], actor: "agent", source: "agent" });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TaskServiceError);
    expect((err as TaskServiceError).code).toBe("label_forbidden");
    // E non è passato NIENTE: nemmeno il `chore` che viaggiava insieme.
    expect(s.get(taskId)!.task.labels).toEqual([]);
  });

  test("l'agente può alzare la mano: `visibile` passa, con la sua provenienza", () => {
    const t = s.setLabels({ taskId, labels: ["visibile", "bugfix"], actor: "agent", source: "agent" });
    expect(t.labels).toEqual([
      { label: "bugfix", source: "agent" },
      { label: "visibile", source: "agent" },
    ]);
  });

  test("anche `decisione` passa: è l'altro modo di passare la card a una persona", () => {
    const t = s.setLabels({ taskId, labels: ["decisione"], actor: "agent", source: "agent" });
    expect(t.labels).toEqual([{ label: "decisione", source: "agent" }]);
  });

  test("nemmeno di sponda: l'agente non può TOGLIERE un `visibile` già scritto", () => {
    s.setLabels({ taskId, labels: ["visibile"], actor: "human", source: "human" });
    expect(() => s.setLabels({ taskId, labels: ["chore"], actor: "agent", source: "agent" }))
      .toThrow(/non può togliere/);
    expect(s.get(taskId)!.task.labels.map((l) => l.label)).toEqual(["visibile"]);
  });

  test("l'umano invece scrive quello che vuole, `invisibile` compreso", () => {
    const t = s.setLabels({ taskId, labels: ["invisibile"], actor: "human", source: "human" });
    expect(t.labels).toEqual([{ label: "invisibile", source: "human" }]);
  });
});

/** File toccati e MAI creati dal task: la forma di gran lunga più comune. */
const mod = (...paths: string[]) => paths.map((path) => ({ path, added: false }));
/** File che i commit propri del task hanno CREATO. */
const add = (...paths: string[]) => paths.map((path) => ({ path, added: true }));

describe("deriveLabelsFromDiff", () => {
  let db: Database; let s: TaskService; let taskId: string;
  beforeEach(() => {
    db = freshDb(); s = svc(db);
    taskId = s.create({ projectId: PID, text: "x" }).id;
  });

  test("dal diff a chi chiude, timbrato `derived`", () => {
    const t = s.deriveLabelsFromDiff({ taskId, files: mod("server/routes/tasks.ts", "docs/x.md") });
    expect(t!.labels).toEqual([
      { label: "bugfix", source: "derived" },
      { label: "invisibile", source: "derived" },
    ]);
  });

  test("solo documenti ⇒ `decisione`, e la card resta di chi decide", () => {
    const t = s.deriveLabelsFromDiff({ taskId, files: mod("docs/PIANO.md") });
    // Nessun genere: il vocabolario non ha una parola per «un piano».
    expect(t!.labels).toEqual([{ label: "decisione", source: "derived" }]);
  });

  test("il ricalcolo porta via anche la classe VECCHIA, non solo la sua gemella", () => {
    // La DELETE guardava due etichette su tre: una `decisione` rimasta accanto a
    // una `visibile` nuova sarebbe una card con due risposte alla stessa domanda.
    s.deriveLabelsFromDiff({ taskId, files: mod("docs/PIANO.md") });
    s.deriveLabelsFromDiff({ taskId, files: mod("client/src/App.tsx") });
    expect(s.get(taskId)!.task.labels).toEqual([
      { label: "bugfix", source: "derived" },
      { label: "visibile", source: "derived" },
    ]);
  });

  test("una consegna successiva RICALCOLA ciò che aveva calcolato lei", () => {
    s.deriveLabelsFromDiff({ taskId, files: mod("server/a.ts") });
    s.deriveLabelsFromDiff({ taskId, files: add("client/src/App.tsx") });
    expect(s.get(taskId)!.task.labels).toEqual([
      { label: "feature", source: "derived" },
      { label: "visibile", source: "derived" },
    ]);
  });

  test("la correzione a mano di un umano NON si sovrascrive alla consegna dopo", () => {
    // Una correzione che scade al turno successivo non è una correzione.
    s.setLabels({ taskId, labels: ["visibile"], actor: "human", source: "human" });
    s.deriveLabelsFromDiff({ taskId, files: mod("server/a.ts") });
    // Il `visibile` a mano è ancora lì, e ancora `human`. Il genere invece si
    // deriva lo stesso: chi chiude e che genere è sono due domande diverse.
    expect(s.get(taskId)!.task.labels).toEqual([
      { label: "bugfix", source: "derived" },
      { label: "visibile", source: "human" },
    ]);
  });

  test("un genere corretto a mano non lo riscrive la consegna dopo", () => {
    s.setLabels({ taskId, labels: ["feature"], actor: "human", source: "human" });
    s.deriveLabelsFromDiff({ taskId, files: mod("server/a.ts") });
    expect(s.get(taskId)!.task.labels).toEqual([
      { label: "feature", source: "human" },
      { label: "invisibile", source: "derived" },
    ]);
  });

  test("niente da scrivere ⇒ `null`, e non un giro di DELETE a vuoto", () => {
    s.setLabels({ taskId, labels: ["visibile", "feature"], actor: "human", source: "human" });
    expect(s.deriveLabelsFromDiff({ taskId, files: mod("server/a.ts") })).toBeNull();
  });

  test("LA PROVA: dopo una consegna il genere è una riga vera in `task_labels`", () => {
    // Il difetto del 12/08: `KIND_LABELS` esisteva, il filtro sulla board pure,
    // e la tabella aveva 50 righe di cui ZERO di genere. La funzione c'era,
    // nessuno scriveva il dato. Questa asserzione guarda la TABELLA, non l'API.
    s.deriveLabelsFromDiff({ taskId, files: [...mod("server/routes/tasks.ts"), ...add("server/services/kind.ts")] });
    const rows = db.prepare(
      "SELECT label, source FROM task_labels WHERE task_id = ? AND label IN ('bugfix','feature','chore','misura')",
    ).all(taskId) as Array<{ label: string; source: string }>;
    expect(rows).toEqual([{ label: "feature", source: "derived" }]);
  });

  test("UNO solo: due consegne non lasciano due generi addosso alla stessa card", () => {
    s.deriveLabelsFromDiff({ taskId, files: add("client/src/New.tsx") });
    s.deriveLabelsFromDiff({ taskId, files: mod("client/src/New.tsx") });
    const kinds = db.prepare(
      "SELECT label FROM task_labels WHERE task_id = ? AND label IN ('bugfix','feature','chore','misura')",
    ).all(taskId) as Array<{ label: string }>;
    expect(kinds).toEqual([{ label: "bugfix" }]);
  });
});

describe("filtro per etichetta sulla lista", () => {
  let db: Database; let s: TaskService;
  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("«solo le visibili in review» è etichetta + colonna insieme", () => {
    const a = s.create({ projectId: PID, text: "vis in review", status: "review" });
    const b = s.create({ projectId: PID, text: "inv in review", status: "review" });
    const c = s.create({ projectId: PID, text: "vis in todo", status: "todo" });
    s.setLabels({ taskId: a.id, labels: ["visibile"], actor: "human", source: "human" });
    s.setLabels({ taskId: b.id, labels: ["invisibile"], actor: "human", source: "human" });
    s.setLabels({ taskId: c.id, labels: ["visibile"], actor: "human", source: "human" });
    const got = s.list({ scope: "project", projectId: PID, status: "review", labels: ["visibile"] });
    expect(got.map((t) => t.id)).toEqual([a.id]);
  });

  test("più etichette = AND, non OR", () => {
    const a = s.create({ projectId: PID, text: "bugfix visibile" });
    const b = s.create({ projectId: PID, text: "solo bugfix" });
    s.setLabels({ taskId: a.id, labels: ["bugfix", "visibile"], actor: "human", source: "human" });
    s.setLabels({ taskId: b.id, labels: ["bugfix"], actor: "human", source: "human" });
    expect(s.list({ scope: "project", projectId: PID, labels: ["bugfix", "visibile"] }).map((t) => t.id))
      .toEqual([a.id]);
    expect(s.list({ scope: "project", projectId: PID, labels: ["bugfix"] })).toHaveLength(2);
  });

  test("un'etichetta ignota non filtra niente invece di filtrare tutto", () => {
    s.create({ projectId: PID, text: "una" });
    expect(s.list({ scope: "project", projectId: PID, labels: ["bugfix-ui"] })).toHaveLength(1);
  });
});
