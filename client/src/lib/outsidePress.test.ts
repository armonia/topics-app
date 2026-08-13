import { describe, it, expect } from 'bun:test';
import { swallowNextClick, type PressHost, type SwallowableEvent } from './outsidePress';

/**
 * Il guardiano che mangia il click dopo una chiusura per pressione esterna.
 *
 * Perché con un finto `document` e non con uno vero: jsdom/happy-dom non sono
 * dipendenze di questo progetto (scelta esplicita, vedi ThreadRuns.test.tsx).
 * Il finto host qui serve a un'altra cosa comunque: rende osservabile la parte
 * che in un DOM vero NON si vede, cioè se il listener viene TOLTO. Un guardiano
 * che mangia il click giusto ma resta appeso mangerebbe anche quello dopo, e in
 * un test su DOM vero i due casi sono indistinguibili finché non è tardi.
 */

interface Registrato { type: string; listener: (e: SwallowableEvent) => void; capture: boolean }

function fakeHost() {
  const listeners: Registrato[] = [];
  const host: PressHost = {
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, capture: options?.capture === true });
    },
    removeEventListener(type, listener) {
      const i = listeners.findIndex((l) => l.type === type && l.listener === listener);
      if (i !== -1) listeners.splice(i, 1);
    },
  };
  return { host, listeners };
}

function fakeEvent() {
  const visti = { stop: 0, prevent: 0 };
  const e: SwallowableEvent = {
    stopPropagation: () => { visti.stop++; },
    preventDefault: () => { visti.prevent++; },
  };
  return { e, visti };
}

function fakeSchedule() {
  const attese: { fn: () => void; ms: number; annullata: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const a = { fn, ms, annullata: false };
    attese.push(a);
    return () => { a.annullata = true; };
  };
  return { schedule, attese };
}

describe('swallowNextClick', () => {
  it('mangia il click successivo e poi si toglie di mezzo', () => {
    const { host, listeners } = fakeHost();
    const { schedule } = fakeSchedule();
    swallowNextClick({ host, schedule });

    expect(listeners).toHaveLength(1);
    // In CATTURA: deve arrivare prima di chi il click lo aspetta davvero.
    expect(listeners[0].capture).toBe(true);

    const { e, visti } = fakeEvent();
    listeners[0].listener(e);
    expect(visti.stop).toBe(1);
    expect(visti.prevent).toBe(1);
    // Uno solo: il secondo click è di nuovo dell'utente.
    expect(listeners).toHaveLength(0);
  });

  it('si disarma da solo se il click non arriva mai', () => {
    const { host, listeners } = fakeHost();
    const { schedule, attese } = fakeSchedule();
    swallowNextClick({ host, schedule });

    expect(attese).toHaveLength(1);
    attese[0].fn();
    expect(listeners).toHaveLength(0);
  });

  it('annulla l’attesa quando il click arriva, così il timer non resta appeso', () => {
    const { host, listeners } = fakeHost();
    const { schedule, attese } = fakeSchedule();
    swallowNextClick({ host, schedule });

    const { e } = fakeEvent();
    listeners[0].listener(e);
    expect(attese[0].annullata).toBe(true);
  });

  it('due armamenti per lo stesso dito lasciano UN guardiano solo', () => {
    // Su touch arrivano sia `touchstart` sia `pointerdown`: `useDismissable`
    // chiama questa funzione due volte per la stessa pressione.
    const { host, listeners } = fakeHost();
    const { schedule } = fakeSchedule();
    swallowNextClick({ host, schedule });
    swallowNextClick({ host, schedule });

    expect(listeners).toHaveLength(1);
    const { e } = fakeEvent();
    listeners[0].listener(e);
    expect(listeners).toHaveLength(0);
  });

  it('il disarmo esplicito è idempotente', () => {
    const { host, listeners } = fakeHost();
    const { schedule } = fakeSchedule();
    const disarma = swallowNextClick({ host, schedule });
    disarma();
    disarma();
    expect(listeners).toHaveLength(0);
  });
});
