/**
 * Archiviare aveva una porta sola. `list()` inchiodava `archived = 0`, la PATCH
 * rifiutava il campo, e in tutto il repo non esisteva una sola scrittura che
 * riportasse `archived` a 0: 74 task erano usciti dalla board senza modo di
 * rivederli, alberi fermi in review compresi.
 *
 * Qui si misura il ritorno, nell'ordine in cui lo vive chi guarda la board:
 * archivia (la card sparisce) → elenca con il filtro (la ritrova) → ripristina
 * → la card è di nuovo in colonna, nella sua colonna, con la sua checklist.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
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
