/**
 * THE DURATION CAP ON A WAIT SERIES, JUDGED FROM OUTSIDE.
 *
 * `WAIT_SERIES_MAX_MS` (4 hours) had ONE reader in the whole repo, inside
 * `deferForWait`: the cap fired only if ANOTHER turn started and re-declared
 * the same wait. If the dispatcher stops admitting anybody - a resource floor,
 * a paused board, a provider on hold - the series grows and nobody looks.
 * Measured 2026-09-17 on the live DB: 2 cards past the cap by 45 and 31 hours,
 * zero `waited_out` parks in the whole history, and `waited_out` is the only
 * state that reaches a push notification (`push-triggers.ts`).
 *
 * What is pinned here is the outside judge: the same logic as `deferForWait`
 * (one function, `parkWaitedOut`), without the attempt refund, and with the
 * guards that keep its hands off a card that is really working.
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

  /** A card that declared a wait and has not seen a turn since. */
  function waitingCard(reason = "aspetto che la CI finisca"): string {
    const t = s.create({ projectId: PID, text: "consegna bloccata", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.deferForWait({ taskId: t.id, reason, minutes: 15, by: "claude" });
    return t.id;
  }

  test("cinque ore e nessun turno partito: la card e' parcheggiata `waited_out`", () => {
    const id = waitingCard();
    expect(s.get(id)!.task.status).toBe("todo");

    // Time passes with nothing starting: exactly the case where `deferForWait`
    // is never called and the cap used to stay blind.
    clock.t += 5 * ORA;
    expect(5 * ORA).toBeGreaterThan(WAIT_SERIES_MAX_MS);

    const parked = s.sweepWaitedOut();
    expect(parked.map((t) => t.id)).toEqual([id]);

    const after = s.get(id)!.task;
    expect(after.status).toBe("backlog");
    expect(after.dispatchState).toBe(PARKED_WAITED_OUT);
    expect(after.dispatchDeferredUntil).toBeNull();
    const note = after.dispatchError ?? "";
    expect(note).toContain("aspetto che la ci finisca");
    expect(note).toContain("la decisione torna a te");
    expect(note.toLowerCase()).not.toContain("fallit");
    // The same line in the thread, not only in the chip's tooltip.
    expect(s.get(id)!.comments.map((c) => c.content).join("\n")).toContain("la decisione torna a te");
  });

  test("dentro il tetto non si tocca niente", () => {
    const id = waitingCard();
    clock.t += 3 * ORA;
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.get(id)!.task.status).toBe("todo");
  });

  test("il giro e' idempotente: la seconda passata non riscrive il parcheggio", () => {
    const id = waitingCard();
    clock.t += 5 * ORA;
    expect(s.sweepWaitedOut()).toHaveLength(1);
    // The card is in `backlog`: outside the two columns where a wait is alive.
    // Without that guard the note would be rewritten every ten seconds
    // forever, which is the noise a park exists to end.
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.get(id)!.task.dispatchState).toBe(PARKED_WAITED_OUT);
  });

  test("nessun tentativo si rimborsa: qui non e' partita nessuna claim", () => {
    // `deferForWait` refunds because the turn that declares the wait had
    // already spent the attempt. This judge claimed nothing: a refund would
    // hand the card a retry nobody paid for.
    const id = waitingCard();
    db.run("UPDATE tasks SET dispatch_attempts = 2 WHERE id = ?", [id]);

    clock.t += 5 * ORA;
    s.sweepWaitedOut();
    expect(s.get(id)!.task.dispatchAttempts).toBe(2);
  });

  test("una card che sta lavorando ADESSO non si parcheggia: `busy` vince sulla riga", () => {
    const id = waitingCard();
    clock.t += 5 * ORA;
    expect(s.sweepWaitedOut({ busy: (taskId) => taskId === id })).toEqual([]);
    expect(s.get(id)!.task.status).toBe("todo");
  });

  test("una board spenta non si muove da sola", () => {
    const id = waitingCard();
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
    const id = waitingCard();
    expect(s.waitedOutIfCapped({ taskId: id })).toBeNull();
    clock.t += 5 * ORA;
    expect(s.waitedOutIfCapped({ taskId: id })!.dispatchState).toBe(PARKED_WAITED_OUT);
  });
});
