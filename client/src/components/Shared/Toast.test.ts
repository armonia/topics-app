/**
 * IL TOAST NON DEVE SVEGLIARE CHI NON STA GUARDANDO.
 *
 * IL GUASTO (misurato il 2026-08-15). `ToastProvider` costruiva il suo context
 * value come letterale nudo, senza `useMemo`: identita' nuova a ogni render del
 * provider, cioe' a ogni render di App. React sveglia OGNI consumatore quando
 * l'identita' del value cambia, e quel risveglio non si ferma ai bordi — passa
 * attraverso `React.memo` e la bailout di `PaneKeepAlive`, quindi arrivava
 * dentro pane congelate e invisibili. `chatPanePropsEqual` (ChatPane.tsx) esiste
 * esattamente per fermare quel traffico, e questo lo scavalcava. Prova
 * collaterale che il costo si vedeva: tre `eslint-disable` in `BranchList.tsx` e
 * uno shim con ref in `App.tsx`, tutti con lo stesso commento — «il context dei
 * toast non e' memoizzato, non metterlo fra le dipendenze».
 *
 * COSA MISURA QUESTO FILE, e perche' cosi'. Non conta le invocazioni di un
 * componente figlio: il renderer disponibile qui (`test/reactHarness`) non
 * implementa nessuna bailout, apposta — un finto scritto da chi scrive il test
 * non puo' essere l'arbitro di «React avrebbe saltato questo componente». Conta
 * invece quante IDENTITA' distinte del valore un consumatore ha visto lungo N
 * render, che e' l'input ESATTO su cui React decide se svegliarlo: una sola
 * identita' su sei giri = il consumatore si renderizza una volta, sei = sei.
 *
 * (jsdom/happy-dom non sono dipendenze di questo progetto — stessa scelta di
 * `Shared/Select.test.tsx` — e `renderToStaticMarkup` monta una volta sola,
 * quindi non puo' vedere un guasto che vive nel SECONDO render.)
  * @covers RUNTIME-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { mount } from '../../test/reactHarness';
import { ToastProvider, ToastOutlet, useToast } from './Toast';

/** Cosa ha visto il mittente, un elemento per render. */
let seen: unknown[] = [];

/** Un mittente qualunque: la stessa cosa che fanno ChatPane, BranchList, FileExplorer… */
function Sender(): ReactNode {
  seen.push(useToast());
  return null;
}

interface Sendable { success: (message: string) => void }

const globals = globalThis as unknown as { requestAnimationFrame?: (cb: (t: number) => void) => number };
let originalRaf: ((cb: (t: number) => void) => number) | undefined;

beforeEach(() => {
  seen = [];
  // `ToastItem` anima l'ingresso con un rAF, che fuori dal browser non esiste.
  // Lo si esegue subito: il test guarda il testo disegnato, non l'animazione.
  originalRaf = globals.requestAnimationFrame;
  globals.requestAnimationFrame = (cb) => { cb(0); return 0; };
});

afterEach(() => {
  globals.requestAnimationFrame = originalRaf;
});

/** Quante identita' distinte ha visto il mittente = quante volte React lo avrebbe renderizzato. */
function distinctSeen(): number {
  return new Set(seen).size;
}

describe('ToastProvider: chi manda un toast non si sottoscrive alla lista', () => {
  test('sei render del provider, UNA sola identita di API per i mittenti', () => {
    const h = mount(createElement(ToastProvider, { children: createElement(Sender) }));
    for (let i = 0; i < 5; i++) h.rerender();
    h.unmount();

    // Sei giri (mount + 5) senza nessuna attivita' di toast, quindi sei letture:
    // il mittente ha ricevuto sempre lo stesso oggetto. Prima della separazione
    // dei due context erano sei oggetti diversi, cioe' sei render propagati a
    // 17+ consumatori, pane congelate comprese.
    expect(seen.length).toBe(6);
    expect(distinctSeen()).toBe(1);
  });

  test('un toast MOSSO non cambia l identita dell API', () => {
    const h = mount(createElement(ToastProvider, { children: createElement(Sender) }));
    (seen[0] as Sendable).success('ciao');
    h.rerender();
    h.unmount();

    // Il provider si e' ri-renderizzato per davvero (la lista e' cambiata) e
    // l'API e' rimasta la stessa: e' tutta la promessa.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(distinctSeen()).toBe(1);
  });

  test('la lista invece si MUOVE, o l outlet non ridisegnerebbe', () => {
    // Il contro-test del precedente: se questo banco «memoizzasse tutto», il
    // caso sopra sarebbe verde a vuoto. Qui si pretende il movimento.
    const h = mount(createElement(ToastProvider, {
      children: [createElement(Sender, { key: 's' }), createElement(ToastOutlet, { key: 'o', fixed: true })],
    }));
    // I due provider, nell'ordine dell'albero: [API, stato].
    const before = h.last().providerValues;
    expect(h.last().text).toBe('');

    (seen[0] as Sendable).success('salvato');
    const after = h.last().providerValues;

    expect(after[0]).toBe(before[0]);      // API: ferma
    expect(after[1]).not.toBe(before[1]);  // lista: mossa
    expect(h.last().text).toContain('salvato');
    h.unmount();
  });

  test('senza provider l API muta e una COSTANTE, non un oggetto nuovo per render', () => {
    // `App` stessa sta SOPRA `<ToastProvider>`, quindi questo ramo e' vivo — e
    // se allocasse ogni volta, chi mette `toast` fra le dipendenze di un
    // `useCallback` (BranchList) le rifarebbe a ogni render.
    const h = mount(createElement(Sender));
    h.rerender();
    h.unmount();
    expect(seen.length).toBe(2);
    expect(distinctSeen()).toBe(1);
  });
});
