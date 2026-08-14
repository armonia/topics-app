/**
 * Una interruzione, una riga.
 *
 * Il 13/08, sul database vivo, il task ae61fb5a portava quattro note per un
 * riavvio solo: alle 10:25:30, 10:25:45 e 10:25:58 «Server ripartito a metà
 * turno», poi alle 10:27:38 «Riavvio del server: ripreso in diretta». Una
 * interruzione, quattro righe che la raccontano — e due di quelle righe si
 * contraddicono su cosa stia succedendo al turno.
 *
 * Perché la dedupe che c'era già non bastava: `addComment` sopprime un testo
 * IDENTICO entro dieci secondi. Quelle righe distavano quindici secondi, e la
 * quarta diceva la stessa cosa con parole diverse. Nessuna delle due condizioni
 * era soddisfatta, quindi passavano tutte.
 *
 * Il cancello è una rivendicazione a finestra: vince il primo che scrive, gli
 * altri tacciono per tre minuti. Il test che conta è il primo — due
 * interruzioni ravvicinate, una riga sola — e sotto c'è la prova che sa
 * diventare rosso: azzerata la finestra, le righe tornano due.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTaskService, type TaskService } from "./tasks";
import { TASKS_DDL, TASKS_FK_STUBS_DDL, TASK_LABELS_DDL } from "../db/test-schema";
import { groupServiceRuns, foldsAway, isServiceComment } from "../../shared/task-comment-service";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(TASKS_DDL);
  db.run(TASKS_FK_STUBS_DDL);
  db.run(`CREATE TABLE task_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL, mentions TEXT, media TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'comment'
  )`);
  db.run(TASK_LABELS_DDL);
  return db;
}

const PID = "topics-app-abc123";

/** Le due frasi vere del 13/08, nell'ordine in cui sono finite sul disco. */
const MID_TURN = "Server ripartito a metà turno: riprendo la stessa sessione, nessun tentativo consumato.";
const LIVE = "Riavvio del server: ripreso in diretta, nessun tentativo consumato.";

/** Un banco col suo orologio: l'ora la muove il test, non l'attesa. */
function bench(interruptClaimMs?: number) {
  const db = freshDb();
  let clock = Date.parse("2026-08-13T10:25:30.000Z");
  let n = 0;
  const s: TaskService = createTaskService(db, {
    now: () => new Date(clock).toISOString(),
    uuid: () => `id-${++n}`,
    ...(interruptClaimMs === undefined ? {} : { interruptClaimMs }),
  });
  const taskId = s.create({ projectId: PID, text: "Un turno interrotto a metà" }).id;
  return { db, s, taskId, advance: (ms: number) => { clock += ms; } };
}

describe("claimInterruption: un riavvio, una riga", () => {
  let b: ReturnType<typeof bench>;
  beforeEach(() => { b = bench(); });

  test("due interruzioni ravvicinate sullo stesso task lasciano UNA riga sola", () => {
    // Esattamente la sequenza misurata: la stessa frase a quindici secondi
    // (fuori dalla dedupe a dieci), poi la frase DIVERSA due minuti dopo.
    expect(b.s.claimInterruption({ taskId: b.taskId, note: MID_TURN })).not.toBeNull();
    b.advance(15_000);
    expect(b.s.claimInterruption({ taskId: b.taskId, note: MID_TURN })).toBeNull();
    b.advance(13_000);
    expect(b.s.claimInterruption({ taskId: b.taskId, note: MID_TURN })).toBeNull();
    b.advance(100_000);
    expect(b.s.claimInterruption({ taskId: b.taskId, note: LIVE })).toBeNull();

    const comments = b.s.get(b.taskId)?.comments ?? [];
    expect(comments.map((c) => c.content)).toEqual([MID_TURN]);
  });

  test("vince il primo che rivendica, perché è quello più vicino alla causa", () => {
    b.s.claimInterruption({ taskId: b.taskId, note: LIVE });
    b.advance(20_000);
    b.s.claimInterruption({ taskId: b.taskId, note: MID_TURN });
    const comments = b.s.get(b.taskId)?.comments ?? [];
    expect(comments.map((c) => c.content)).toEqual([LIVE]);
  });

  test("la riga vinta è 'service', quindi cade nel fold che il thread già fa", () => {
    // Il punto per cui questa nota NON è un kind tutto suo: il raggruppamento
    // del thread conosce 'service', e un kind sconosciuto tornerebbe indietro
    // da `rowToComment` come 'comment' — cioè smetterebbe di piegarsi.
    const written = b.s.claimInterruption({ taskId: b.taskId, note: MID_TURN });
    expect(written?.kind).toBe("service");
    expect(isServiceComment(written!)).toBe(true);

    b.advance(4 * 60_000);
    b.s.claimInterruption({ taskId: b.taskId, note: LIVE });
    const runs = groupServiceRuns(b.s.get(b.taskId)?.comments ?? []);
    expect(runs).toHaveLength(1);
    expect(foldsAway(runs[0]!)).toBe(true);
  });

  test("un'interruzione DAVVERO nuova, passata la finestra, ha ancora la sua riga", () => {
    // La finestra non è un lucchetto: separa «la stessa interruzione raccontata
    // da più scrittori» da «due interruzioni diverse», e due interruzioni vere
    // distano quanto il tetto a orologio di un turno.
    b.s.claimInterruption({ taskId: b.taskId, note: MID_TURN });
    b.advance(3 * 60_000 + 1);
    expect(b.s.claimInterruption({ taskId: b.taskId, note: LIVE })).not.toBeNull();
    expect((b.s.get(b.taskId)?.comments ?? []).map((c) => c.content)).toEqual([MID_TURN, LIVE]);
  });

  test("il campo è per TASK: l'altra card interrotta dallo stesso riavvio parla lo stesso", () => {
    const altro = b.s.create({ projectId: PID, text: "L'altra card che lavorava" }).id;
    b.s.claimInterruption({ taskId: b.taskId, note: MID_TURN });
    expect(b.s.claimInterruption({ taskId: altro, note: MID_TURN })).not.toBeNull();
    expect((b.s.get(altro)?.comments ?? []).map((c) => c.content)).toEqual([MID_TURN]);
  });

  test("su un task che non esiste tace, e non esplode", () => {
    expect(b.s.claimInterruption({ taskId: "mai-nato", note: MID_TURN })).toBeNull();
    expect(b.s.claimInterruption({ taskId: b.taskId, note: "   " })).toBeNull();
  });

  test("LA PROVA CHE SA DIVENTARE ROSSO: tolta la finestra, tornano quattro righe", () => {
    // Stessa sequenza del primo test contro una finestra azzerata, cioè il
    // comportamento di prima: ogni scrittore racconta la sua versione. Se
    // questo test resta verde con `interruptClaimMs` a zero, il cancello del
    // primo test non stava misurando la finestra ma qualcos'altro.
    const senza = bench(0);
    senza.s.claimInterruption({ taskId: senza.taskId, note: MID_TURN });
    senza.advance(15_000);
    senza.s.claimInterruption({ taskId: senza.taskId, note: MID_TURN });
    senza.advance(13_000);
    senza.s.claimInterruption({ taskId: senza.taskId, note: MID_TURN });
    senza.advance(100_000);
    senza.s.claimInterruption({ taskId: senza.taskId, note: LIVE });

    const comments = senza.s.get(senza.taskId)?.comments ?? [];
    expect(comments.map((c) => c.content)).toEqual([MID_TURN, MID_TURN, MID_TURN, LIVE]);
  });
});
