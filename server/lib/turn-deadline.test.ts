import { describe, expect, test } from "bun:test";
import { armTurnDeadline } from "./turn-deadline";

/** Orologio finto: i timer si fanno scattare a mano, uno alla volta. */
function fakeTimers() {
  let seq = 0;
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
  };
}

describe("armTurnDeadline — il tempo dell'umano non si conta", () => {
  test("nessuna domanda in sospeso: allo scadere il turno si taglia", () => {
    const t = fakeTimers();
    let expired = 0;
    armTurnDeadline({
      ms: 30_000, isWaitingForHuman: () => false, onExpired: () => { expired++; },
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
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
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();               // domanda ancora aperta → riarmo
    expect(expired).toBe(0);
    waiting = false;        // risponde
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
});
