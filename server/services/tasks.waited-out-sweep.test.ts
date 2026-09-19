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
 * @covers KANBAN-92
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

/**
 * ONE LONG WAIT IS NOT A SERIES PAST ITS CAP.
 *
 * `deferForWait` clamps `minutes` to 1440 and production uses that room: of
 * the 78 retry notes on the live DB the top figures are 240, 180 and 120
 * minutes. Inside `deferForWait` a lone wait could never trip the duration cap
 * — `serieMs` is 0 on the first declaration — so the cap has only ever judged
 * a SERIES. Reading `wait_since` from outside turned it into something else:
 * an 8-hour wait parked after 4 hours, four hours before the wake-up the agent
 * itself had asked for, with a note claiming one wait in a row four hours old
 * on a wait that is neither a series nor expired.
 */
describe("il tetto sulla durata non scavalca la sveglia che l'agente ha chiesto", () => {
  let db: Database; let s: TaskService;
  const clock = { t: T0 };
  beforeEach(() => { clock.t = T0; db = freshDb(); s = svc(db, clock); });

  /** One long wait, the shape production asks for up to 240 minutes. */
  function longWait(minutes: number, reason = "aspetto la finestra di manutenzione"): string {
    const t = s.create({ projectId: PID, text: "consegna bloccata", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 2 });
    s.deferForWait({ taskId: t.id, reason, minutes, by: "claude" });
    return t.id;
  }

  test("480 minuti chiesti, 241 passati: la card non si tocca", () => {
    const id = longWait(480);
    expect(s.get(id)!.task.waitStreak).toBe(1);

    clock.t += 241 * 60_000;
    expect(241 * 60_000).toBeGreaterThan(WAIT_SERIES_MAX_MS);

    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.waitedOutIfCapped({ taskId: id })).toBeNull();
    const after = s.get(id)!.task;
    expect(after.status).toBe("todo");
    expect(after.dispatchState).toBe("waiting");
    // And nobody wrote the wrong sentence on it.
    expect(s.get(id)!.comments.map((c) => c.content).join("\n")).not.toContain("la decisione torna a te");
  });

  test("scaduta la sveglia e passato il tetto SOPRA di essa, la card si parcheggia", () => {
    const id = longWait(480);
    // 8 hours asked for plus the 4 of the cap: the time nobody looked at the
    // card starts at the wake-up, not at the declaration.
    clock.t += 8 * ORA + 4 * ORA + 60_000;
    expect(s.sweepWaitedOut().map((t) => t.id)).toEqual([id]);
    expect(s.get(id)!.task.dispatchState).toBe(PARKED_WAITED_OUT);
  });

  test("appena scaduta la sveglia il turno vince: il tetto parte da li'", () => {
    const id = longWait(480);
    clock.t += 8 * ORA;
    // The two conditions never come true in the same instant on a lone
    // wait: here the wake-up has arrived and the cap is still 4 hours away.
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.get(id)!.task.status).toBe("todo");
  });

  test("una SERIE oltre il tetto si parcheggia, e la nota dice due attese", () => {
    const id = longWait(15, "aspetto che la CI finisca");
    clock.t += 3 * ORA;
    s.claim({ taskId: id, cap: 5, maxAttempts: 2 });
    s.deferForWait({ taskId: id, reason: "aspetto che la CI finisca", minutes: 15, by: "claude" });
    expect(s.get(id)!.task.waitStreak).toBe(2);

    clock.t += 61 * 60_000; // series: 4h01 old, wake-up 46 minutes past
    expect(s.sweepWaitedOut().map((t) => t.id)).toEqual([id]);
    const note = s.get(id)!.task.dispatchError ?? "";
    expect(note).toContain("Sono 2 attese di fila");
    expect(note).toContain("da circa 4 ore");
  });

  test("una serie oltre il tetto ma con la sveglia ancora davanti aspetta la sveglia", () => {
    const id = longWait(15, "aspetto che la CI finisca");
    clock.t += 3 * ORA;
    s.claim({ taskId: id, cap: 5, maxAttempts: 2 });
    // The second wait asks for two hours: the series tops the cap at 4h, but
    // at 5h there is a turn the agent has already booked to look.
    s.deferForWait({ taskId: id, reason: "aspetto che la CI finisca", minutes: 120, by: "claude" });

    clock.t += 61 * 60_000; // 4h01 of series, wake-up in 59 minutes
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.get(id)!.task.status).toBe("todo");

    clock.t += 60 * 60_000; // the wake-up is past, the cap was topped an hour ago
    expect(s.sweepWaitedOut().map((t) => t.id)).toEqual([id]);
    expect(s.get(id)!.task.dispatchState).toBe(PARKED_WAITED_OUT);
  });

  test("il coordinatore che aspetta i figli non eredita la serie di attese di prima", () => {
    // THE OTHER SIDE OF THE SIGN, and it was a real hole. The judge reads
    // "no window = the series is over", which is true; the converse - "a window
    // means the series is alive" - is not. `deliverToReviewBySystem` writes a
    // ten-minute window when the parent finishes with children still open, and
    // it is not a wait the agent declared: it is coordination. With the old
    // columns left standing under it, the sweep parked a card that is
    // coordinating its own children, with a note false on both counts ("2 waits
    // in a row for the same reason, about 6 hours") - and `waited_out` is the
    // one state that reaches a push notification.
    const id = longWait(15, "aspetto che la ci finisca");
    clock.t += 3 * ORA;
    s.claim({ taskId: id, cap: 5, maxAttempts: 2 });
    s.deferForWait({ taskId: id, reason: "aspetto che la ci finisca", minutes: 15, by: "claude" });
    expect(s.get(id)!.task.waitStreak).toBe(2);

    // A turn ran and ended with children still open: the series is over.
    clock.t += 30 * 60_000;
    s.claim({ taskId: id, cap: 5, maxAttempts: 2 });
    const child = s.create({ projectId: PID, text: "sottotask", status: "in_progress", parentTaskId: id });
    expect(child.parentTaskId).toBe(id);
    s.deliverToReviewBySystem({ taskId: id, reason: "turno finito coi figli aperti" });
    expect(s.get(id)!.task.waitStreak).toBe(0);
    expect(s.get(id)!.task.waitSince).toBeNull();

    // Six hours after the FIRST wait: the old series would top the cap.
    clock.t += 3 * ORA;
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.get(id)!.task.status).toBe("todo");
  });

  test("senza finestra di rinvio non c'e' piu' niente da cronometrare", () => {
    // The claim clears the column, so a row without a window is a card a turn
    // has ALREADY restarted on. See the bench below: that is the end of the
    // series, not a series measured from `wait_since`.
    const id = longWait(480);
    db.run("UPDATE tasks SET dispatch_deferred_until = NULL WHERE id = ?", [id]);
    clock.t += 5 * ORA;
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.waitedOutIfCapped({ taskId: id })).toBeNull();
  });
});

/**
 * THE DURATION CAP IS A CAP ON A SERIES THAT IS STILL RUNNING.
 *
 * Measured against `origin/main` on the exact shape the live DB carries (card
 * `c4d48d3e`: `wait_streak` 1, `wait_since` 2026-09-15T00:42, five hours old,
 * `dispatch_deferred_until` NULL):
 *
 *     main    → reconcile: in_progress / working, one turn started
 *     branch  → reconcile: backlog / waited_out, ZERO turns
 *
 * The change meant to restart a stalled queue was PARKING a card that started
 * on main. The shape is not theoretical: no dispatcher requeue clears
 * `wait_since` (only human→todo, review and done do), so the column outlives
 * the very turn that STOPPED waiting. Reproduced below through the real path —
 * declare a wait, let a turn claim and end without re-declaring it — because
 * it is the claim itself that clears the window.
 *
 * The sign we read is `dispatch_deferred_until`: `deferForWait` writes it on
 * every declaration and `claim` nulls it, so with `wait_since` set, a NULL
 * window means exactly "a turn has restarted since the last declaration". Not
 * `task_attempts.created_at` and not `in_progress_at`: both answer "when did
 * the last turn start", which on a streak of two or more is ALWAYS after
 * `wait_since` (that is what a series is), so comparing them against
 * `wait_since` would switch the whole backstop off.
 *
 * @covers KANBAN-92
 */
describe("un turno ripartito senza ridichiarare l'attesa chiude la serie", () => {
  let db: Database; let s: TaskService;
  const clock = { t: T0 };
  beforeEach(() => { clock.t = T0; db = freshDb(); s = svc(db, clock); });

  /** Declare a wait, then let a real turn claim the card and end. */
  function waitThenTurn(): string {
    const t = s.create({ projectId: PID, text: "consegna bloccata", status: "todo" });
    s.claim({ taskId: t.id, cap: 5, maxAttempts: 5 });
    s.deferForWait({ taskId: t.id, reason: "aspetto che la CI finisca", minutes: 15, by: "claude" });
    clock.t += 30 * 60_000; // the wake-up rings and a turn answers it
    expect(s.claim({ taskId: t.id, cap: 5, maxAttempts: 5 })).not.toBeNull();
    return t.id;
  }

  test("la forma esatta del DB vivo: streak 1, cinque ore, nessuna finestra", () => {
    const id = waitThenTurn();
    // The turn ends with nothing delivered and the card goes back in the queue:
    // the requeue leaves `wait_since` and `wait_streak` exactly where they were.
    s.release({ taskId: id, requeue: true, by: "dispatcher" });
    clock.t += 5 * ORA;

    const row = db.prepare(
      "SELECT status, wait_streak, wait_since, dispatch_deferred_until AS wake FROM tasks WHERE id = ?",
    ).get(id) as { status: string; wait_streak: number; wait_since: string; wake: string | null };
    expect(row.status).toBe("todo");
    expect(row.wait_streak).toBe(1);
    expect(row.wait_since).not.toBeNull();
    expect(row.wake).toBeNull();
    expect(clock.t - Date.parse(row.wait_since)).toBeGreaterThan(WAIT_SERIES_MAX_MS);

    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.waitedOutIfCapped({ taskId: id })).toBeNull();
    expect(s.get(id)!.task.status).toBe("todo");
    expect(s.get(id)!.task.dispatchState).not.toBe(PARKED_WAITED_OUT);
  });

  test("col turno ancora in corso la card non si parcheggia sotto i piedi dell'agente", () => {
    // `c4d48d3e` on the live DB is this one: `in_progress`, streak 1, the
    // window cleared by its own claim. `busy` is a register that lives in the
    // dispatcher's process, so a restart empties it — the row has to answer on
    // its own.
    const id = waitThenTurn();
    clock.t += 5 * ORA;
    expect(s.get(id)!.task.status).toBe("in_progress");
    expect(s.sweepWaitedOut()).toEqual([]);
    expect(s.waitedOutIfCapped({ taskId: id })).toBeNull();
  });

  test("ma se il turno RIDICHIARA l'attesa la serie continua, e il tetto la prende", () => {
    // The other half of the rule: the window is back, so the series is running
    // again and the backstop must still fire. Without this the fix above would
    // be indistinguishable from deleting the sweep.
    const id = waitThenTurn();
    s.deferForWait({ taskId: id, reason: "aspetto che la CI finisca", minutes: 15, by: "claude" });
    expect(s.get(id)!.task.waitStreak).toBe(2);
    clock.t += 5 * ORA;
    expect(s.sweepWaitedOut().map((t) => t.id)).toEqual([id]);
    expect(s.get(id)!.task.dispatchState).toBe(PARKED_WAITED_OUT);
  });
});
