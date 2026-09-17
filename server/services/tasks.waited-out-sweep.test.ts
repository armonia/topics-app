/**
 * IL TETTO SULLA DURATA DI UNA SERIE DI ATTESE, GUARDATO DA FUORI.
 *
 * `WAIT_SERIES_MAX_MS` (4 ore) aveva UN solo lettore in tutto il repo, dentro
 * `deferForWait`: il tetto scattava solo se un ALTRO turno partiva e
 * ridichiarava la stessa attesa. Se il dispatcher smette di ammettere qualcuno
 * — un pavimento di risorse, una board in pausa, un provider fermo — la serie
 * cresce e nessuno la guarda. Misurato il 17/09/2026 sul DB vivo: 2 card oltre
 * il tetto da 45 e 31 ore, zero parcheggi `waited_out` in tutta la storia, e
 * `waited_out` e' l'unico stato che arriva a una notifica push
 * (`push-triggers.ts`).
 *
 * Qui si prova il giudice di fuori: stessa logica di `deferForWait` (una sola
 * funzione, `parkWaitedOut`), senza il rimborso del tentativo, e con le guardie
 * che tengono le mani lontane da una card che sta davvero lavorando.
 *
 * @covers KANBAN-84
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { TaskService } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";
import { PARKED_WAITED_OUT, WAIT_SERIES_MAX_MS } from "../../shared/board";

const T0 = Date.parse("2026-09-15T09:00:00.000Z");
const ORA = 3_600_000;

describe("la serie di attese sfonda il tetto senza che nessun turno riparta", () => {
  let db: Database; let s: TaskService;
  const clock = { t: T0 };
  beforeEach(() => { clock.t = T0; db = freshDb(); s = svc(db, clock); });

  /** Una card che ha dichiarato un'attesa e non ha piu' visto un turno. */
  function inAttesa(reason = "aspetto che la CI finisca"): string {
    const t = s.create({ projectId: PID, text: "consegna bloccata", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.deferForWait({ taskId: t.id, reason, minutes: 15, by: "claude" });
    return t.id;
  }

  test("cinque ore e nessun turno partito: la card e' parcheggiata `waited_out`", () => {
    const id = inAttesa();
    expect(s.get(id)!.task.status).toBe("todo");

    // Il tempo passa senza che parta niente: e' esattamente il caso in cui
    // `deferForWait` non viene mai chiamata e il tetto restava cieco.
    clock.t += 5 * ORA;
    expect(5 * ORA).toBeGreaterThan(WAIT_SERIES_MAX_MS);

    const parcheggiate = s.sweepWaitedOut();
    expect(parcheggiate.map((t) => t.id)).toEqual([id]);

    const dopo = s.get(id)!.task;
    expect(dopo.status).toBe("backlog");
    expect(dopo.dispatchState).toBe(PARKED_WAITED_OUT);
    expect(dopo.dispatchDeferredUntil).toBeNull();
    const nota = dopo.dispatchError ?? "";
    expect(nota).toContain("aspetto che la ci finisca");
    expect(nota).toContain("la decisione torna a te");
    expect(nota.toLowerCase()).not.toContain("fallit");
    // La stessa riga nel thread, non solo nel tooltip del chip.
    expect(s.get(id)!.comments.map((c) => c.content).join("\n")).toContain("la decisione torna a te");
  });

  test("dentro il tetto non si tocca niente", () => {
    const id = inAttesa();
    clock.t += 3 * ORA;
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.get(id)!.task.status).toBe("todo");
  });

  test("il giro e' idempotente: la seconda passata non riscrive il parcheggio", () => {
    const id = inAttesa();
    clock.t += 5 * ORA;
    expect(s.sweepWaitedOut()).toHaveLength(1);
    // La card e' in `backlog`: fuori dalle due colonne dove un'attesa e' viva.
    // Senza questa guardia la nota si riscriverebbe ogni dieci secondi per
    // sempre, che e' il rumore che i parcheggi esistono per evitare.
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.get(id)!.task.dispatchState).toBe(PARKED_WAITED_OUT);
  });

  test("nessun tentativo si rimborsa: qui non e' partita nessuna claim", () => {
    // `deferForWait` rimborsa perche' il turno che dichiara l'attesa il
    // tentativo l'aveva gia' speso. Questo giudice non ha reclamato niente: un
    // rimborso gli regalerebbe un tentativo che nessuno ha pagato.
    const id = inAttesa();
    db.run("UPDATE tasks SET dispatch_attempts = 2 WHERE id = ?", [id]);

    clock.t += 5 * ORA;
    s.sweepWaitedOut();
    expect(s.get(id)!.task.dispatchAttempts).toBe(2);
  });

  test("una card che sta lavorando ADESSO non si parcheggia: `busy` vince sulla riga", () => {
    const id = inAttesa();
    clock.t += 5 * ORA;
    expect(s.sweepWaitedOut({ busy: (taskId) => taskId === id })).toEqual([]);
    expect(s.get(id)!.task.status).toBe("todo");
  });

  test("una board spenta non si muove da sola", () => {
    const id = inAttesa();
    clock.t += 5 * ORA;
    expect(s.sweepWaitedOut({ eligible: () => false })).toEqual([]);
    expect(s.get(id)!.task.status).toBe("todo");
  });

  test("una card senza serie di attese non e' un candidato", () => {
    const t = s.create({ projectId: PID, text: "mai aspettato niente", status: "todo" });
    clock.t += 50 * ORA;
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.get(t.id)!.task.status).toBe("todo");
  });

  test("`waitedOutIfCapped` e' il giudice, e risponde null quando non c'e' niente da fare", () => {
    const id = inAttesa();
    expect(s.waitedOutIfCapped({ taskId: id })).toBeNull();
    clock.t += 5 * ORA;
    expect(s.waitedOutIfCapped({ taskId: id })!.dispatchState).toBe(PARKED_WAITED_OUT);
  });
});
