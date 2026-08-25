/**
 * L'OROLOGIO DELLA SIDEBAR DEVE CAMMINARE MENTRE L'AGENTE LAVORA.
 *
 * IL GUASTO (misurato il 2026-08-15). `SessionActivityText` arma un
 * `setInterval` da 1s per far scorrere il «Xs» accanto allo stato, e l'effetto
 * dipendeva dall'INTERO descrittore di attività. Quel descrittore arriva da
 * `useSessionActivity`, che passa da `useShallow`: cambia identità a ogni
 * cambio di campo, e il campo che si muove di più è `tool`. Un agente che passa
 * da Read a Bash a Edit più di una volta al secondo — cioè un agente normale —
 * smontava e rimontava l'intervallo prima che scattasse anche una volta sola:
 * il contatore restava inchiodato su «0s» per tutto il turno, che è
 * esattamente il numero che nessuno guarda più.
 *
 * COME SI MISURA. Timer finti (in bun `jest.advanceTimersByTime` muove anche
 * `Date.now()`, verificato) e il renderer di `test/reactHarness`, perché
 * jsdom/happy-dom non sono dipendenze di questo progetto e
 * `renderToStaticMarkup` non ha un secondo render — e questo è un guasto che
 * vive solo nei render successivi al primo.
  * @covers CHAT-WAIT-02
 */
import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../../test/reactHarness';
import { SessionActivity } from './SessionActivity';
import { signalsActions, type SessionActivitySignal } from '../../state/signals';

const SUBJECT = 'topic-clock';

function working(tool: string, turnSince: number): SessionActivitySignal {
  return { phase: 'tool-running', tier: null, working: true, tool, since: turnSince, turnSince };
}

function seed(signal: SessionActivitySignal): void {
  signalsActions.setSessionActivity(new Map([[SUBJECT, signal]]));
}

/** I secondi che la riga sta mostrando: «Esegue un comando · 4s» → 4. */
function shownSeconds(text: string): number {
  const m = /·\s*(\d+)s/.exec(text);
  return m ? Number(m[1]) : Number.NaN;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  signalsActions.setSessionActivity(new Map());
});

describe('SessionActivity: il contatore del turno', () => {
  test('cammina anche se lo strumento cambia più spesso di una volta al secondo', () => {
    const t0 = Date.now();
    seed(working('Read', t0));
    const h = mount(createElement(SessionActivity, { subjectId: SUBJECT }));
    expect(shownSeconds(h.last().text)).toBe(0);

    // Cinque giri da 900ms: 4,5s di turno, e a ogni giro cambia SOLO `tool` —
    // cioè arriva un descrittore nuovo di identità con lo stesso `working`.
    const tools = ['Bash', 'Edit', 'Grep', 'Read', 'Bash'];
    for (const tool of tools) {
      jest.advanceTimersByTime(900);
      seed(working(tool, t0));
    }

    // Con la dipendenza sull'oggetto l'intervallo non scattava MAI: 0s.
    expect(shownSeconds(h.last().text)).toBeGreaterThanOrEqual(4);
    h.unmount();
  });

  test('a turno fermo non arma nessun intervallo', () => {
    const t0 = Date.now();
    seed({ phase: 'awaiting-user', tier: 'input', working: false, since: t0 - 5000 });
    const h = mount(createElement(SessionActivity, { subjectId: SUBJECT }));
    const before = h.passes().length;
    // Un minuto di orologio: la riga ferma legge il tick CONDIVISO da 10s
    // (useSharedNow), non un timer suo. Se qui si armasse l'intervallo da 1s,
    // ogni riga di sidebar ne aprirebbe uno — la regressione che il commento in
    // cima al componente mette in guardia.
    jest.advanceTimersByTime(60_000);
    const renders = h.passes().length - before;
    // DUE limiti, e servono tutti e due. Misurato: 6 giri da fermo (il tick
    // condiviso da 10s su 60s) contro 66 con l'intervallo da 1s armato.
    // Il SOLO tetto era soddisfatto anche da ZERO, cioè da un orologio che non
    // cammina o da un montaggio che non è mai avvenuto: il pavimento è ciò che
    // rende il tetto una misura invece di una tautologia. E il tetto non sta
    // sul valore esatto — un giro in più lo farebbe fallire per niente —, sta
    // dove il guasto vive: sopra i 60 dell'intervallo al secondo.
    expect(renders).toBeGreaterThanOrEqual(5);
    expect(renders).toBeLessThanOrEqual(12);
    h.unmount();
  });
});
