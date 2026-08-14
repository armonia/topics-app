import { describe, expect, test } from 'bun:test';
import { createBurstCoalescer, latestWins } from './burstCoalescer';

/** Un orologio guidato a mano: il test decide quando scade una finestra. */
function fakeClock() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    schedule: (fn: () => void) => { timers.set(++seq, fn); return seq; },
    cancel: (h: unknown) => { timers.delete(h as number); },
    /** Fa scadere ogni timer armato adesso (non quelli armati durante lo scatto). */
    tick: () => {
      const scaduti = [...timers.entries()];
      timers.clear();
      for (const [, fn] of scaduti) fn();
    },
    get armati() { return timers.size; },
  };
}

function counter() {
  const state = { corse: 0 };
  return { state, run: async () => { state.corse++; } };
}

describe('createBurstCoalescer', () => {
  test('il primo evento parte SUBITO: chi ha appena mosso una card non aspetta', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    c.trigger();
    expect(state.corse).toBe(1);
  });

  test('24 eventi nella stessa finestra costano DUE letture, non 24', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    for (let i = 0; i < 24; i++) c.trigger();
    expect(state.corse).toBe(1); // solo il primo, gli altri 23 sono in coda
    clock.tick();
    expect(state.corse).toBe(2); // la coda: uno stato solo, quello finale
    clock.tick();
    expect(state.corse).toBe(2); // e nessuna lettura a vuoto dopo
  });

  test('nessun evento durante la finestra: nessuna lettura in coda', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    c.trigger();
    clock.tick();
    expect(state.corse).toBe(1);
  });

  test('la lettura finale è sempre DOPO l ultimo evento', () => {
    const clock = fakeClock();
    const eventi: string[] = [];
    const c = createBurstCoalescer({
      windowMs: 400,
      run: async () => { eventi.push('lettura'); },
      schedule: clock.schedule, cancel: clock.cancel,
    });
    c.trigger(); eventi.push('evento1');
    c.trigger(); eventi.push('evento2');
    clock.tick();
    expect(eventi).toEqual(['lettura', 'evento1', 'evento2', 'lettura']);
  });

  test('finestra chiusa: un evento nuovo riparte subito', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    c.trigger();
    clock.tick();          // finestra chiusa senza coda
    c.trigger();
    expect(state.corse).toBe(2);
  });

  test('dispose spegne la coda e ogni evento successivo', () => {
    const clock = fakeClock();
    const { state, run } = counter();
    const c = createBurstCoalescer({ windowMs: 400, run, schedule: clock.schedule, cancel: clock.cancel });
    c.trigger();
    c.trigger();           // mette in coda
    c.dispose();
    expect(clock.armati).toBe(0);
    clock.tick();
    c.trigger();
    expect(state.corse).toBe(1);
  });

  test('un errore nella lettura non blocca le successive', async () => {
    const clock = fakeClock();
    let corse = 0;
    const c = createBurstCoalescer({
      windowMs: 400,
      run: async () => { corse++; throw new Error('rete giù'); },
      schedule: clock.schedule, cancel: clock.cancel,
    });
    c.trigger();
    c.trigger();
    await Promise.resolve();
    clock.tick();
    expect(corse).toBe(2);
  });
});

describe('latestWins', () => {
  test('una risposta SUPERATA non scrive sopra a una più recente', async () => {
    const scritte: string[] = [];
    const guarded = latestWins<string>((v) => scritte.push(v));
    let sbloccaLenta: (v: string) => void = () => {};
    const lenta = new Promise<string>((res) => { sbloccaLenta = res; });

    const p1 = guarded(() => lenta);                  // parte per prima, torna per ultima
    const p2 = guarded(() => Promise.resolve('nuova'));
    await p2;
    sbloccaLenta('vecchia');
    await p1;

    expect(scritte).toEqual(['nuova']);
  });

  test('in sequenza scrivono tutte', async () => {
    const scritte: string[] = [];
    const guarded = latestWins<string>((v) => scritte.push(v));
    await guarded(() => Promise.resolve('a'));
    await guarded(() => Promise.resolve('b'));
    expect(scritte).toEqual(['a', 'b']);
  });
});
