/**
 * Una consegna viene ANNOTATA con cio' che non regge, e non viene mai fermata.
 *
 * PERCHE' ANNOTA E NON BLOCCA, che e' la sola decisione di progetto qui dentro.
 * L'audit dei task `done` ha trovato 14 carte chiuse senza che il lavoro
 * esistesse, e i quattro controlli meccanici le prendono. Ma il controllo puo'
 * sbagliare: nella sua PRIMA ORA di vita accusava 20 percorsi che esistevano
 * tutti, perche' i rapporti citano i file per nome corto e lui li risolveva
 * dalla radice del repo. Un cancello che blocca una consegna onesta viene
 * spento entro un mese, e allora non c'e' nemmeno per quella disonesta.
 *
 * Quindi la nota si legge prima di approvare, e l'umano decide. Cio' che questi
 * test tengono e' che la nota non possa mai trasformarsi in un ostacolo:
 * qualunque cosa succeda nella sonda, la card arriva in review.
 *
 * @covers KANBAN-11
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { type Database } from "bun:sqlite";
import { freshDb } from "./tasks-test-db";
import { createTaskService } from "./tasks";

const PID = "topics-app-test01";
let db: Database;
let svc: ReturnType<typeof createTaskService>;

beforeEach(() => {
  db = freshDb();
  svc = createTaskService(db);
});

/** Una card portata fino a `review` da un agente, con il suo rapporto. */
function consegna(report: string): string {
  const t = svc.create({ projectId: PID, text: "una card" });
  svc.addComment({ taskId: t.id, author: "agent-1", content: report });
  svc.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review" } });
  return t.id;
}

const note = (id: string): string[] =>
  (db.prepare("SELECT content FROM task_comments WHERE task_id = ? AND kind = 'review-note'").all(id) as Array<{ content: string }>)
    .map((r) => r.content);

describe("la nota compare quando una rivendicazione non regge", () => {
  test("uno sha inventato viene nominato nella nota", () => {
    const id = consegna("Fatto (commit 0000000deadbee1). Tutto verde.");
    const n = note(id).join("\n");
    expect(n).toContain("0000000deadbee1");
  });

  test("e la card e' comunque in review", () => {
    // Il punto dell'intero file: annotare non e' fermare.
    const id = consegna("Fatto (commit 0000000deadbee1).");
    expect(svc.get(id)?.task.status).toBe("review");
  });

  test("la nota dice che non blocca, cosi' chi legge sa cosa farne", () => {
    const id = consegna("Fatto (commit 0000000deadbee1).");
    expect(note(id).join("\n")).toContain("Non blocca");
  });
});

describe("la nota NON compare quando non c'e' niente da dire", () => {
  test("un rapporto in prosa, senza rivendicazioni, non produce niente", () => {
    // «Niente da verificare» e' il caso legittimo di chi racconta a parole.
    // Annotarlo trasformerebbe la nota in rumore su ogni singola consegna.
    const id = consegna("Ho guardato il problema e ho deciso di non toccarlo: la causa e' altrove.");
    expect(note(id)).toEqual([]);
  });

  test("una rivendicazione VERA non viene accusata", () => {
    // La meta' che decide se la nota e' utile o solo fastidiosa.
    const id = consegna("Fatto: vedi `server/services/tasks.ts`.");
    expect(note(id)).toEqual([]);
  });
});

describe("una consegna arriva in review comunque", () => {
  test("anche con un rapporto che sbaglia tutto", () => {
    const id = consegna("Fatto (commit 1111111abcdef22), migration 999, vedi `file/che/non/esiste.ts`.");
    expect(svc.get(id)?.task.status, "un rilievo non deve mai fermare una consegna").toBe("review");
    expect(note(id).length).toBeGreaterThan(0);
  });

  test("la nota sta in UNO slot, non in una pila", () => {
    // `annotateDeliveryClaims` gira a ogni transizione verso review. Senza
    // `replaces` il thread guadagnerebbe una riga identica ogni volta.
    const id = consegna("Fatto (commit 0000000deadbee1).");
    svc.update({ taskId: id, actor: "human", by: "u", patch: { status: "in_progress" } });
    svc.addComment({ taskId: id, author: "agent-1", content: "Rifatto (commit 0000000deadbee1)." });
    svc.update({ taskId: id, actor: "agent", by: "agent-1", patch: { status: "review" } });
    expect(note(id).length, "due giri, due note: lo slot non ha tenuto").toBe(1);
  });
});
