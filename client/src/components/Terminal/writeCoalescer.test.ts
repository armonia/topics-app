import { describe, test, expect } from 'bun:test';
import { createWriteCoalescer, BACKGROUND_FLUSH_MS, VISIBLE_FLUSH_MS, type TerminalChunk } from './writeCoalescer';

/**
 * Orologio finto: i timer non partono davvero, li facciamo scadere noi. Serve a
 * verificare la cadenza senza aspettare 250ms veri per ogni asserzione.
 *
 * @covers TERM-01
 */
function fakeClock() {
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer(fn: () => void, ms: number) {
      const id = next++;
      timers.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(id: ReturnType<typeof setTimeout>) {
      timers.delete(id as unknown as number);
    },
    /** Fa scattare tutti i timer armati. */
    fire() {
      const armed = [...timers.entries()];
      timers.clear();
      for (const [, t] of armed) t.fn();
    },
    get armed() {
      return timers.size;
    },
    get delays() {
      return [...timers.values()].map((t) => t.ms);
    },
  };
}

function harness(watched = false, layout = true) {
  const clock = fakeClock();
  const written: TerminalChunk[] = [];
  let isWatched = watched;
  let hasLayout = layout;
  const coalescer = createWriteCoalescer({
    write: (chunk) => { written.push(chunk); },
    isWatched: () => isWatched,
    hasLayout: () => hasLayout,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    clock,
    written,
    coalescer,
    watch(v: boolean) { isWatched = v; },
    layout(v: boolean) { hasLayout = v; },
  };
}

describe('createWriteCoalescer', () => {
  // Terza cadenza: un terminale VISIBILE ma senza il cursore della tastiera non
  // ha nessun eco da rendere immediato, e in uno split ce ne sono diversi che
  // altrimenti ricostruirebbero le righe a 60Hz tutti insieme.
  test('la cadenza si rilegge a ogni arming: visibile 66ms, in secondo piano 250ms', () => {
    const clock = fakeClock();
    const written: TerminalChunk[] = [];
    let visible = true;
    const coalescer = createWriteCoalescer({
      write: (chunk) => { written.push(chunk); },
      isWatched: () => false,
      flushMs: () => (visible ? VISIBLE_FLUSH_MS : BACKGROUND_FLUSH_MS),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    coalescer.push('a');
    expect(clock.delays).toEqual([VISIBLE_FLUSH_MS]);
    clock.fire();
    visible = false;
    coalescer.push('b');
    expect(clock.delays).toEqual([BACKGROUND_FLUSH_MS]);
    clock.fire();
    expect(written).toEqual(['a', 'b']);
  });

  // Regressione: una pane dentro `display:none` non ha box, xterm misura 0 e
  // NON mette 0 in cache (WidthCache v6), quindi ogni scarico rimisura ogni
  // glifo — il caso peggiore, non il migliore. Senza layout non si scarica a
  // tempo: si aspetta il ritorno della visibilità.
  test('senza layout → non arma il timer e non scarica a tempo', () => {
    const h = harness(false, false);
    h.coalescer.push('a');
    h.coalescer.push('b');
    expect(h.clock.armed).toBe(0);
    h.clock.fire(); // nessun timer da far scattare
    expect(h.written).toEqual([]);
    expect(h.coalescer.pendingBytes).toBe(2);
  });

  test('nascosta DOPO che il timer era armato → il timer viene disinnescato', () => {
    const h = harness(false, true);
    h.coalescer.push('a');
    expect(h.clock.armed).toBe(1);
    h.layout(false);
    h.coalescer.push('b');
    expect(h.clock.armed).toBe(0);
    h.clock.fire();
    expect(h.written).toEqual([]);
  });

  test('senza layout il tetto di byte scarica lo stesso — mai perdere byte', () => {
    const clock = fakeClock();
    const written: TerminalChunk[] = [];
    const coalescer = createWriteCoalescer({
      write: (chunk) => { written.push(chunk); },
      isWatched: () => false,
      hasLayout: () => false,
      maxPendingBytes: 4,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    coalescer.push('abc');
    expect(written).toEqual([]);
    coalescer.push('de');
    expect(written).toEqual(['abc', 'de']);
    expect(coalescer.pendingBytes).toBe(0);
  });

  test('torna il layout → flush() esplicito consegna in ordine', () => {
    const h = harness(false, false);
    h.coalescer.push('a');
    h.coalescer.push('b');
    h.layout(true);
    h.coalescer.flush();
    expect(h.written).toEqual(['a', 'b']);
  });

  test('guardato → scrive subito, nessun timer armato', () => {
    const h = harness(true);
    h.coalescer.push('a');
    h.coalescer.push('b');
    expect(h.written).toEqual(['a', 'b']);
    expect(h.clock.armed).toBe(0);
  });

  test('non guardato → accumula e scarica UNA volta alla scadenza', () => {
    const h = harness(false);
    h.coalescer.push('a');
    h.coalescer.push('b');
    h.coalescer.push('c');
    expect(h.written).toEqual([]);
    // Un solo timer per l'intera raffica: è questo che taglia i redraw.
    expect(h.clock.armed).toBe(1);
    expect(h.clock.delays).toEqual([250]);

    h.clock.fire();
    expect(h.written).toEqual(['a', 'b', 'c']);
    expect(h.coalescer.pendingBytes).toBe(0);
  });

  test('lo scarico rispetta l\'ordine di arrivo anche misto string/bytes', () => {
    const h = harness(false);
    const bytes = new Uint8Array([0x1b, 0x5b, 0x41]);
    h.coalescer.push('primo');
    h.coalescer.push(bytes);
    h.coalescer.push('terzo');
    h.clock.fire();
    expect(h.written).toEqual(['primo', bytes, 'terzo']);
  });

  test('tornare guardato: l\'arretrato esce PRIMA del chunk nuovo', () => {
    const h = harness(false);
    h.coalescer.push('vecchio');
    h.watch(true);
    h.coalescer.push('nuovo');
    // Se il chunk nuovo scavalcasse la coda lo stato ANSI sarebbe corrotto.
    expect(h.written).toEqual(['vecchio', 'nuovo']);
    // E il timer pendente va disarmato, altrimenti riscriverebbe a vuoto.
    expect(h.clock.armed).toBe(0);
  });

  test('flush() esplicito svuota subito ed è idempotente', () => {
    const h = harness(false);
    h.coalescer.push('x');
    h.coalescer.flush();
    expect(h.written).toEqual(['x']);
    h.coalescer.flush();
    expect(h.written).toEqual(['x']);
    expect(h.clock.armed).toBe(0);
  });

  test('oltre il tetto scarica SUBITO invece di scartare byte', () => {
    const clock = fakeClock();
    const written: TerminalChunk[] = [];
    const coalescer = createWriteCoalescer({
      write: (c) => { written.push(c); },
      isWatched: () => false,
      maxPendingBytes: 8,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    coalescer.push('1234');
    expect(written).toEqual([]);
    coalescer.push('5678');
    // Nessun byte perso: la coda esce tutta, in ordine.
    expect(written).toEqual(['1234', '5678']);
    expect(coalescer.pendingBytes).toBe(0);
    expect(clock.armed).toBe(0);
  });

  test('una write rientrante non riscrive i byte già in coda', () => {
    const clock = fakeClock();
    const written: TerminalChunk[] = [];
    let reentered = false;
    const coalescer: ReturnType<typeof createWriteCoalescer> = createWriteCoalescer({
      write: (c) => {
        written.push(c);
        // Un handler di xterm che reagisce all'output e scrive a sua volta.
        if (!reentered) { reentered = true; coalescer.flush(); }
      },
      isWatched: () => false,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    coalescer.push('a');
    coalescer.push('b');
    clock.fire();
    expect(written).toEqual(['a', 'b']);
  });

  test('dispose() ferma il timer e ignora le push successive', () => {
    const h = harness(false);
    h.coalescer.push('a');
    expect(h.clock.armed).toBe(1);
    h.coalescer.dispose();
    expect(h.clock.armed).toBe(0);
    expect(h.coalescer.pendingBytes).toBe(0);

    // Dopo lo smontaggio il terminale è distrutto: scriverci sopra esploderebbe.
    h.coalescer.push('b');
    h.coalescer.flush();
    h.clock.fire();
    expect(h.written).toEqual([]);
  });
});
