import { describe, expect, test } from "bun:test";
import { armTurnDeadline } from "./turn-deadline";

/**
 * Fake bench: timers are fired by hand, and TIME is moved by hand.
 *
 * Time matters now that the cap looks at SILENCE instead of duration: `fire()`
 * without advancing the clock means "the timer went off but not an instant has
 * passed", and there the cap must re-arm rather than cut. Modelling the timers
 * without modelling the clock made the correct behaviour look broken.
 *
 * The turn's hard cap: it fires on silence, never on a live process, and it
 * re-arms while a question is on screen.
 *
 * @covers CHAT-REL-03
 */
function fakeTimers() {
  let seq = 0;
  let ora = 1_000_000;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimer: (h: unknown) => { pending.delete(h as number); },
    /** Fa scattare l'ultimo timer armato. */
    fire() {
      const last = [...pending.keys()].pop();
      if (last === undefined) throw new Error("nessun timer armato");
      const t = pending.get(last)!;
      pending.delete(last);
      t.fn();
      return t.ms;
    },
    armedCount: () => pending.size,
    lastDelay: () => [...pending.values()].pop()?.ms,
    now: () => ora,
    /** Lets time pass with nothing arriving on the stream. */
    silenzio(ms: number) { ora += ms; },
  };
}

describe("armTurnDeadline — il tempo dell'umano non si conta", () => {
  test("nessuna domanda in sospeso: allo scadere il turno si taglia", () => {
    const t = fakeTimers();
    let expired = 0;
    armTurnDeadline({
      ms: 30_000, isWaitingForHuman: () => false, onExpired: () => { expired++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silenzio(30_000);
    t.fire();
    expect(expired).toBe(1);
  });

  test("domanda a schermo: NON scatta, si riarma", () => {
    // Il guasto vero: trenta minuti dopo, il tetto uccideva un turno fermo su
    // una domanda — e la risposta scritta un attimo dopo non trovava nessuno.
    const t = fakeTimers();
    let expired = 0, rearmed = 0;
    armTurnDeadline({
      ms: 30_000, rearmMs: 60_000,
      isWaitingForHuman: () => true,
      onExpired: () => { expired++; },
      onRearm: () => { rearmed++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();
    expect(expired).toBe(0);
    expect(rearmed).toBe(1);
    expect(t.lastDelay()).toBe(60_000); // ricontrolla fra un minuto
    t.fire();
    expect(expired).toBe(0);
    expect(rearmed).toBe(2);
  });

  test("l'umano risponde: il riarmo dopo trova campo libero e il tetto torna a valere", () => {
    const t = fakeTimers();
    let expired = 0;
    let waiting = true;
    armTurnDeadline({
      ms: 30_000, rearmMs: 60_000,
      isWaitingForHuman: () => waiting,
      onExpired: () => { expired++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silenzio(30_000);
    t.fire();               // domanda ancora aperta → riarmo
    expect(expired).toBe(0);
    waiting = false;        // risponde
    t.silenzio(60_000);
    t.fire();               // il controllo dopo: nessuno aspetta più
    expect(expired).toBe(1);
  });

  test("chiuso il turno, il tetto non scatta più — nemmeno se un timer era in volo", () => {
    const t = fakeTimers();
    let expired = 0;
    const d = armTurnDeadline({
      ms: 30_000, isWaitingForHuman: () => false, onExpired: () => { expired++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    d.clear();
    expect(t.armedCount()).toBe(0);
    expect(expired).toBe(0);
  });

  test("il turno finisce mentre una domanda è aperta: nessun timer resta acceso", () => {
    const t = fakeTimers();
    const d = armTurnDeadline({
      ms: 30_000, rearmMs: 60_000, isWaitingForHuman: () => true, onExpired: () => {},
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();               // riarmo
    expect(t.armedCount()).toBe(1);
    d.clear();
    expect(t.armedCount()).toBe(0);
  });

  // ── The cap counts SILENCE, not elapsed time ───────────────────────────────

  test("un turno che LAVORA non si taglia, per quanto duri", () => {
    // The real fault, measured: 60 agent turns cut by the clock while they were
    // working, the most recent on 2026-08-21 at 00:37.
    const t = fakeTimers();
    let expired = 0;
    const d = armTurnDeadline({
      ms: 30_000, isWaitingForHuman: () => false, onExpired: () => { expired++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    // Two hours of turn, with a sign of life every 20 seconds.
    for (let i = 0; i < 360; i++) {
      t.silenzio(20_000);
      d.noteActivity();
      while (t.armedCount() > 0 && t.lastDelay() !== undefined && t.lastDelay()! <= 20_000) t.fire();
    }
    expect(expired).toBe(0);
  });

  test("smesso di parlare, il tetto scatta dopo `ms` di silenzio", () => {
    const t = fakeTimers();
    let expired = 0;
    const d = armTurnDeadline({
      ms: 30_000, isWaitingForHuman: () => false, onExpired: () => { expired++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silenzio(25_000);
    d.noteActivity();          // still alive
    t.fire();                  // the timer fires but the silence is zero
    expect(expired).toBe(0);
    t.silenzio(30_000);        // now it really has gone quiet
    t.fire();
    expect(expired).toBe(1);
  });

  test("il timer che scatta troppo presto si riarma per il tempo che manca", () => {
    // This keeps the cap precise: it does not double the wait on every sign of life.
    const t = fakeTimers();
    const d = armTurnDeadline({
      ms: 30_000, isWaitingForHuman: () => false, onExpired: () => {},
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    t.silenzio(10_000);
    d.noteActivity();
    t.silenzio(20_000);
    t.fire();                  // 20s of silence out of 30, so 10s left
    expect(t.lastDelay()).toBe(10_000);
  });

  test("dopo `clear` un segno di vita non riaccende niente", () => {
    const t = fakeTimers();
    let expired = 0;
    const d = armTurnDeadline({
      ms: 30_000, isWaitingForHuman: () => false, onExpired: () => { expired++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer, now: t.now,
    });
    d.clear();
    d.noteActivity();
    expect(t.armedCount()).toBe(0);
    expect(expired).toBe(0);
  });
});
