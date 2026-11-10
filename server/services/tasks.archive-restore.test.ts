/**
 * Archiving was a one-way door. `list()` pinned `archived = 0`, the PATCH
 * refused the field, and nothing in the repo ever wrote `archived` back to 0:
 * 74 tasks had left the board with no way to see them again, trees parked in
 * review included.
 *
 * This measures the way back, in the order someone watching the board lives it:
 * archive (the card disappears), list with the filter (it is found), restore,
 * and the card is back in its own column with its checklist.
 *
 * @covers KANBAN-18
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { freshDb } from "./tasks-test-db";


const PID = "topics-app-abc123";

function svc(db: Database): TaskService {
  let n = 0;
  return createTaskService(db, { now: () => "2026-08-13T09:00:00.000Z", uuid: () => `id-${++n}` });
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe("l'archivio ha un ritorno", () => {
  let db: Database; let s: TaskService;
  const board = (archived?: boolean) =>
    s.list({ scope: "project", projectId: PID, rootsOnly: true, archived });

  beforeEach(() => { db = freshDb(); s = svc(db); });

  test("archivia, elenca col filtro, ripristina: la card torna in colonna", () => {
    const t = s.create({ projectId: PID, text: "Consegna del pannello", status: "review" });
    const altro = s.create({ projectId: PID, text: "Un task che resta" });

    // Prima: sulla board, non nell'archivio.
    expect(ids(board())).toEqual([t.id, altro.id]);
    expect(ids(board(true))).toEqual([]);

    s.archive({ taskId: t.id, projectId: PID });
    expect(ids(board())).toEqual([altro.id]);
    // IL FILTRO: senza questo ramo il task era una riga che nessuna lista
    // mostrava più.
    expect(ids(board(true))).toEqual([t.id]);

    const tornato = s.restore({ taskId: t.id, projectId: PID });
    expect(tornato).not.toBeNull();
    // Nella sua colonna: il ripristino non è una riapertura, `review` resta
    // `review`.
    expect(tornato!.status).toBe("review");
    expect(ids(board())).toEqual([t.id, altro.id]);
    expect(ids(board(true))).toEqual([]);
  });

  test("il ripristino scende come l'archiviazione: torna anche la checklist", () => {
    const padre = s.create({ projectId: PID, text: "Albero consegnato" });
    const step = s.create({ projectId: PID, text: "Primo passo", parentTaskId: padre.id });
    const nipote = s.create({ projectId: PID, text: "Passo annidato", parentTaskId: step.id });

    s.archive({ taskId: padre.id, projectId: PID });
    expect(s.get(padre.id)!.children).toEqual([]);

    s.restore({ taskId: padre.id, projectId: PID });
    expect(ids(s.get(padre.id)!.children)).toEqual([step.id]);
    // `children` filtra gli archiviati: il nipote che ricompare è la misura
    // che il ripristino è sceso fino in fondo.
    expect(ids(s.get(step.id)!.children)).toEqual([nipote.id]);
  });

  test("uno step archiviato da solo è la radice del suo archivio, e risale al padre vivo", () => {
    const padre = s.create({ projectId: PID, text: "Radice viva" });
    const step = s.create({ projectId: PID, text: "Step archiviato da solo", parentTaskId: padre.id });

    s.archive({ taskId: step.id, projectId: PID });
    // La board mostra le radici; l'archivio mostra le radici DELL'ARCHIVIO,
    // altrimenti questo step non comparirebbe da nessuna parte.
    expect(ids(board())).toEqual([padre.id]);
    expect(ids(board(true))).toEqual([step.id]);

    s.restore({ taskId: step.id, projectId: PID });
    expect(ids(s.get(padre.id)!.children)).toEqual([step.id]);
    expect(ids(board(true))).toEqual([]);
  });

  test("un figlio ripristinato risale: il padre archiviato torna con lui, o resterebbe invisibile", () => {
    const padre = s.create({ projectId: PID, text: "Padre archiviato" });
    const step = s.create({ projectId: PID, text: "Step da recuperare", parentTaskId: padre.id });
    s.archive({ taskId: padre.id, projectId: PID });

    s.restore({ taskId: step.id, projectId: PID });
    expect(ids(board())).toEqual([padre.id]);
    expect(ids(s.get(padre.id)!.children)).toEqual([step.id]);
  });

  test("il ripristino è scoped al progetto, e su un id che non esiste risponde null", () => {
    const t = s.create({ projectId: PID, text: "Card di un'altra board" });
    s.archive({ taskId: t.id, projectId: PID });

    expect(s.restore({ taskId: t.id, projectId: "un-altro-progetto" })).toBeNull();
    expect(s.restore({ taskId: "id-inesistente", projectId: PID })).toBeNull();
    // Il rifiuto non ha scritto niente: la card è ancora nell'archivio.
    expect(ids(board(true))).toEqual([t.id]);
  });
});

describe("una card archiviata non resta «in coda»", () => {
  // 10/11: 11 archived todo cards still carried dispatch_state='queued' for
  // weeks and looked like a stuck PC queue nobody woke up.
  test("archiviare spegne lo stato queued del sottoalbero", () => {
    const db = freshDb(); const s = svc(db);
    const padre = s.create({ projectId: PID, text: "In coda", status: "todo" });
    const child = s.create({ projectId: PID, text: "Figlio in coda", parentTaskId: padre.id, status: "todo" });
    db.prepare("UPDATE tasks SET dispatch_state = 'queued'").run();
    s.archive({ taskId: padre.id, projectId: PID });
    const rows = db.prepare("SELECT dispatch_state FROM tasks WHERE id IN (?, ?)").all(padre.id, child.id) as Array<{ dispatch_state: string | null }>;
    expect(rows.map((r) => r.dispatch_state)).toEqual([null, null]);
  });
});
