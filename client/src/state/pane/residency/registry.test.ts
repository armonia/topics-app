import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MIN_DWELL_MS, RESIDENCY_BUDGET, type ResidencyCandidate } from './policy';
import {
  EVICT_DELAY_MS,
  __resetResidency,
  __residencyDebug,
  getResidencySnapshot,
  holdKey,
  isResident,
  releaseSurface,
  reportSurface,
  subscribeResidency,
  type ResidencyClock,
} from './registry';

/**
 * Orologio finto: il tempo avanza solo quando lo diciamo noi, e i timer scadono
 * in ordine. Serve perché due delle tre regole del registro sono temporali
 * (dwell, ritardo di sfratto) e testarle con `await sleep()` renderebbe la suite
 * lenta e intermittente.
 *
 * @covers LEAK-01
 */
function fakeClock() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: ResidencyClock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  return {
    clock,
    advance(ms: number) {
      const target = t + ms;
      for (;;) {
        let nextId: number | undefined;
        let nextAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < nextAt) {
            nextAt = timer.at;
            nextId = id;
          }
        }
        if (nextId === undefined) break;
        const timer = timers.get(nextId)!;
        timers.delete(nextId);
        t = timer.at;
        timer.fn();
      }
      t = target;
    },
    pending: () => timers.size,
  };
}

let ck: ReturnType<typeof fakeClock>;

beforeEach(() => {
  ck = fakeClock();
  __resetResidency(ck.clock);
});
afterEach(() => {
  __resetResidency();
});

function browser(...keys: string[]): ResidencyCandidate[] {
  return keys.map((key) => ({ key, cls: 'heavy' as const }));
}
function chat(...keys: string[]): ResidencyCandidate[] {
  return keys.map((key) => ({ key, cls: 'light' as const }));
}
function snap(): string[] {
  return [...getResidencySnapshot()].sort();
}
/** Oltre il dwell E oltre il ritardo di sfratto: la decisione è applicata. */
function settle(): void {
  ck.advance(MIN_DWELL_MS + EVICT_DELAY_MS + 1);
}

describe('ammissione', () => {
  test('la pane visibile entra subito, senza aspettare nessun timer', () => {
    reportSurface('s1', chat('a', 'b'), ['a']);
    expect(isResident('a')).toBe(true);
  });

  test('una superficie che riporta gli stessi dati non notifica di nuovo', () => {
    let n = 0;
    subscribeResidency(() => { n++; });
    reportSurface('s1', chat('a'), ['a']);
    expect(n).toBe(1);
    reportSurface('s1', chat('a'), ['a']);
    reportSurface('s1', chat('a'), ['a']);
    expect(n).toBe(1);
  });

  test('cambiare la pane attiva ammette la nuova senza smontare la vecchia', () => {
    reportSurface('s1', chat('a', 'b'), ['a']);
    reportSurface('s1', chat('a', 'b'), ['b']);
    expect(snap()).toEqual(['a', 'b']);
  });
});

describe('sfratto', () => {
  test('oltre il tetto la meno recente cade — ma solo dopo il ritardo', () => {
    const keys = Array.from({ length: 8 }, (_, i) => `b${i}`);
    // Visita una pane cara alla volta, lasciando scadere il dwell fra una e
    // l'altra: è la passeggiata che oggi lascia otto WKWebView vive.
    for (const k of keys) {
      reportSurface('s1', browser(...keys), [k]);
      ck.advance(MIN_DWELL_MS + 1);
    }
    ck.advance(EVICT_DELAY_MS + 1);
    // Pavimento (l'ultima visibile) + il budget della classe.
    expect(getResidencySnapshot().size).toBe(1 + RESIDENCY_BUDGET.heavy);
    expect(isResident('b7')).toBe(true); // l'ultima visitata
    expect(isResident('b0')).toBe(false); // la prima
  });

  /**
   * Uno split a cinque pane care che collassa su una sola visibile: quattro
   * candidate contese, budget 3, quindi esattamente una da sfrattare. È lo
   * scenario più piccolo in cui lo SFRATTO PER BUDGET (non la potatura di una
   * pane chiusa) si osserva senza dipendere dall'intreccio dei timer.
   */
  function oneOverBudget(): string[] {
    const keys = ['b0', 'b1', 'b2', 'b3', 'b4'];
    reportSurface('s1', browser(...keys), keys); // tutte visibili: pavimento
    ck.advance(MIN_DWELL_MS + 1); // il dwell delle nascoste partirà da scaduto
    reportSurface('s1', browser(...keys), ['b4']); // lo split si richiude
    return keys;
  }

  test('nulla viene smontato prima che il ritardo sia trascorso', () => {
    oneOverBudget();
    // Il ricalcolo ha già deciso, ma il componente è ancora montato: è la
    // finestra in cui la pane browser spegne la sua WKWebView e persiste l'URL.
    expect(__residencyDebug().pendingRemoval).toEqual(['b3']);
    expect(isResident('b3')).toBe(true);
    ck.advance(EVICT_DELAY_MS - 1);
    expect(isResident('b3')).toBe(true);
    ck.advance(2);
    expect(isResident('b3')).toBe(false);
  });

  test('tornare su una pane in odore di sfratto annulla lo sfratto', () => {
    const keys = oneOverBudget();
    expect(__residencyDebug().pendingRemoval).toContain('b3');
    reportSurface('s1', browser(...keys), ['b3']); // l'utente ci torna
    expect(__residencyDebug().pendingRemoval).not.toContain('b3');
    ck.advance(EVICT_DELAY_MS + 1);
    expect(isResident('b3')).toBe(true);
  });

  test('il dwell scade da solo: non serve un altro cambio di layout', () => {
    // Il buco che il timer di dwell chiude. Nove pane care visitate in fretta:
    // al momento del ricalcolo sono tutte protette dal dwell, e senza sveglia
    // resterebbero montate finché l'utente non tocca qualcosa.
    const keys = Array.from({ length: 9 }, (_, i) => `b${i}`);
    for (const k of keys) {
      reportSurface('s1', browser(...keys), [k]);
      ck.advance(100);
    }
    expect(getResidencySnapshot().size).toBe(9);
    settle(); // solo il tempo passa: nessun report, nessun evento
    expect(getResidencySnapshot().size).toBe(1 + RESIDENCY_BUDGET.heavy);
  });

  test('le classi hanno tetti separati: le chat non affamano le pane browser', () => {
    const chats = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const browsers = Array.from({ length: 6 }, (_, i) => `b${i}`);
    const all = [...chat(...chats), ...browser(...browsers)];
    for (const k of [...chats, ...browsers]) {
      reportSurface('s1', all, [k]);
      ck.advance(MIN_DWELL_MS + 1);
    }
    settle();
    const live = getResidencySnapshot();
    const liveHeavy = browsers.filter((k) => live.has(k)).length;
    const liveLight = chats.filter((k) => live.has(k)).length;
    expect(liveHeavy).toBeLessThanOrEqual(RESIDENCY_BUDGET.heavy + 1);
    expect(liveLight).toBeLessThanOrEqual(RESIDENCY_BUDGET.light + 1);
  });
});

describe('pavimento', () => {
  test('una pane visibile non viene mai sfrattata, per quante ne apri', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `b${i}`);
    for (const k of keys) {
      reportSurface('s1', browser(...keys), [k]);
      ck.advance(MIN_DWELL_MS + 1);
    }
    settle();
    expect(isResident('b19')).toBe(true);
  });

  test('in split tutte le visibili restano, anche oltre il budget', () => {
    const keys = Array.from({ length: 6 }, (_, i) => `b${i}`);
    reportSurface('s1', browser(...keys), keys); // sei gruppi, sei attive
    settle();
    expect(snap()).toEqual(keys.slice().sort());
  });
});

describe('hold', () => {
  test("una chiave trattenuta sopravvive anche quando è la più vecchia", () => {
    const keys = Array.from({ length: 8 }, (_, i) => `b${i}`);
    const release = holdKey('b0'); // un agente sta guidando questa pane
    for (const k of keys) {
      reportSurface('s1', browser(...keys), [k]);
      ck.advance(MIN_DWELL_MS + 1);
    }
    settle();
    expect(isResident('b0')).toBe(true);
    release();
    settle();
    expect(isResident('b0')).toBe(false);
  });

  test('refcount: due hold, e la pane si libera solo con il secondo rilascio', () => {
    const keys = Array.from({ length: 8 }, (_, i) => `b${i}`);
    const r1 = holdKey('b0');
    const r2 = holdKey('b0');
    for (const k of keys) {
      reportSurface('s1', browser(...keys), [k]);
      ck.advance(MIN_DWELL_MS + 1);
    }
    settle();
    r1();
    settle();
    expect(isResident('b0')).toBe(true);
    r2();
    settle();
    expect(isResident('b0')).toBe(false);
  });

  test('rilasciare due volte non scala il contatore due volte', () => {
    const r1 = holdKey('x');
    holdKey('x');
    r1();
    r1();
    r1();
    expect(__residencyDebug().holds['x']).toBe(1);
  });
});

describe('più superfici', () => {
  test('il tetto è globale: due superfici non raddoppiano il budget', () => {
    // È il bug che il registro esiste per togliere. `visitedKeys` era per
    // superficie: quattro progetti aperti = quattro volte il tetto.
    const a = Array.from({ length: 5 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 5 }, (_, i) => `b${i}`);
    for (const k of a) {
      reportSurface('sA', browser(...a), [k]);
      reportSurface('sB', browser(...b), [b[0]!]);
      ck.advance(MIN_DWELL_MS + 1);
    }
    for (const k of b) {
      reportSurface('sB', browser(...b), [k]);
      ck.advance(MIN_DWELL_MS + 1);
    }
    settle();
    // Due pavimenti (una visibile per superficie) + UN budget condiviso.
    expect(getResidencySnapshot().size).toBe(2 + RESIDENCY_BUDGET.heavy);
  });

  test('la stessa chiave in due superfici conta una volta sola', () => {
    reportSurface('sA', browser('condivisa', 'a'), ['condivisa']); // visitata
    reportSurface('sB', browser('condivisa', 'b'), ['b']);
    reportSurface('sA', browser('condivisa', 'a'), ['a']);
    settle();
    expect(isResident('condivisa')).toBe(true);
    expect(getResidencySnapshot().size).toBeLessThanOrEqual(2 + RESIDENCY_BUDGET.heavy);
  });

  test('una superficie che si smonta libera i suoi slot', () => {
    reportSurface('sA', browser('a1', 'a2', 'a3'), ['a2']); // a2 visitata
    reportSurface('sA', browser('a1', 'a2', 'a3'), ['a1']);
    reportSurface('sB', browser('b1'), ['b1']);
    settle();
    expect(isResident('a2')).toBe(true);
    releaseSurface('sA');
    settle();
    expect(isResident('a1')).toBe(false);
    expect(isResident('a2')).toBe(false);
    expect(isResident('b1')).toBe(true);
  });

  test('rilasciare una superficie che non esiste non fa nulla', () => {
    reportSurface('sA', chat('a'), ['a']);
    releaseSurface('mai-registrata');
    expect(isResident('a')).toBe(true);
  });
});

describe('potatura', () => {
  test('una pane chiusa esce, ma con lo stesso ritardo di uno sfratto', () => {
    // Sparire da tutte le superfici per UN commit capita quando una chat viene
    // instradata dentro un progetto: smontarla in quell'istante costerebbe
    // scroll e cronologia per quello che l'utente vede come un drag di tab.
    reportSurface('s1', chat('a', 'b'), ['b']); // 'b' visitata
    reportSurface('s1', chat('a', 'b'), ['a']);
    expect(isResident('b')).toBe(true);
    reportSurface('s1', chat('a'), ['a']); // 'b' chiusa
    expect(isResident('b')).toBe(true); // non ancora
    ck.advance(EVICT_DELAY_MS + 1);
    expect(isResident('b')).toBe(false);
  });

  test('una pane che sparisce e ritorna entro il ritardo non viene smontata', () => {
    reportSurface('s1', chat('a', 'b'), ['b']); // 'b' visitata
    reportSurface('s1', chat('a', 'b'), ['a']);
    reportSurface('s1', chat('a'), ['a']);
    ck.advance(EVICT_DELAY_MS / 2);
    reportSurface('s2', chat('b'), ['b']); // riapparsa in un'altra superficie
    ck.advance(EVICT_DELAY_MS + 1);
    expect(isResident('b')).toBe(true);
  });
});

describe('snapshot', () => {
  test('il riferimento resta lo stesso finché non cambia nulla', () => {
    reportSurface('s1', chat('a'), ['a']);
    const first = getResidencySnapshot();
    reportSurface('s1', chat('a'), ['a']);
    expect(getResidencySnapshot()).toBe(first);
  });

  test('cambiare solo la pane attiva NON cambia il riferimento', () => {
    // È l'ottimizzazione che rende il registro gratuito allo switch di tab:
    // entrambe erano già residenti, l'appartenenza non cambia, quindi
    // `useSyncExternalStore` non fa ri-renderizzare nessuno.
    reportSurface('s1', chat('a', 'b'), ['b']);
    reportSurface('s1', chat('a', 'b'), ['a']); // entrambe già residenti
    const first = getResidencySnapshot();
    reportSurface('s1', chat('a', 'b'), ['b']);
    expect(getResidencySnapshot()).toBe(first);
  });

  test("il riferimento cambia quando entra una chiave nuova", () => {
    reportSurface('s1', chat('a', 'b'), ['b']);
    reportSurface('s1', chat('a', 'b'), ['a']);
    const first = getResidencySnapshot();
    reportSurface('s1', chat('a', 'b', 'c'), ['c']);
    expect(getResidencySnapshot()).not.toBe(first);
    expect(snap()).toEqual(['a', 'b', 'c']);
  });

  test('disiscriversi ferma le notifiche', () => {
    let n = 0;
    const off = subscribeResidency(() => { n++; });
    reportSurface('s1', chat('a'), ['a']);
    const seen = n;
    off();
    reportSurface('s1', chat('a', 'b'), ['b']);
    expect(n).toBe(seen);
  });
});

describe('igiene', () => {
  test('a regime non restano timer appesi', () => {
    reportSurface('s1', chat('a', 'b'), ['a']);
    settle();
    expect(ck.pending()).toBe(0);
  });

  test('svuotare tutte le superfici svuota il registro', () => {
    reportSurface('s1', chat('a', 'b'), ['a']);
    releaseSurface('s1');
    settle();
    expect(snap()).toEqual([]);
    expect(ck.pending()).toBe(0);
  });
});
