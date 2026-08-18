/**
 * IL TETTO SI VEDE, E LE DUE SUPERFICI NE MOSTRANO UNO SOLO.
 *
 * La promessa è quella fatta da chi usa la app: «non ci deve essere tetto
 * globale se non quello visualizzabile dalle settings board». Quindi due cose,
 * e nessuna delle due la tiene in piedi il compilatore:
 *
 *  1. il controllo DISEGNA i due numeri (quanti al lavoro, di quanti), presi
 *     dallo store e non da una copia sua;
 *  2. lo montano davvero ENTRAMBE le superfici, il menu ▾ del titolo e il
 *     pannello delle impostazioni, e nessuna delle due parla col server per
 *     conto proprio.
 *
 * Il punto 2 è controllato sul SORGENTE, con lo stesso metodo (e lo stesso
 * motivo) di `ThreadRuns.test.tsx`: `TaskDetail.tsx` e `KanbanBoardPane.tsx`
 * tirano dentro l'API, il layout delle pane e una dozzina di store, quindi non
 * si montano in un test unitario, e «la superficie ha smesso di chiamarlo» è
 * una modifica di una riga. `bun test` non risolve nemmeno l'alias `@/` che
 * quei file usano.
 *
 * (jsdom/happy-dom non sono dipendenze di questo progetto, come dice
 * `ThreadRuns.test.tsx`: il montaggio è `renderToStaticMarkup`.)
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { GlobalCapControl } from './GlobalCapControl';
import { GlobalOnlySettingsPanel, GlobalSettingsSection } from './BoardSettingsSections';
import { adoptDispatchCapacity, adoptGlobalCap } from '../../state/globalDispatchCap';
import type { DispatchCapacity } from '../../lib/board';

const machine = (over: Partial<DispatchCapacity> = {}): DispatchCapacity => ({
  recommended: 4,
  cores: 12,
  totalMemGB: 32,
  load1: 2.5,
  // La misura che comanda il tetto: quanta CPU tiene la NOSTRA flotta, e quanta
  // gliene spetta (metà dei 12 core). Il `load1` qui sopra è rimasto per la
  // modalità notturna e per gli host senza sonda, non è più il freno.
  oursCores: 0,
  budgetCores: 6,
  reason: '12 core, base 4',
  running: 0,
  ...over,
});

/** Il testo che una persona legge, senza i tag. */
function words(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 5 });
  adoptDispatchCapacity(machine());
});

describe('what the control draws', () => {
  test('says how many are working AND out of how many', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 8 });
    adoptDispatchCapacity(machine({ running: 3 }));
    expect(words(renderToStaticMarkup(<GlobalCapControl />))).toContain('3 di 8');
  });

  test('the number comes from the store, the input field included', () => {
    // Due montaggi = le due superfici aperte insieme. Non c'è nessuna variante
    // per superficie apposta: entrambe disegnano questo, dallo stesso store.
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 17 });
    adoptDispatchCapacity(machine({ running: 9 }));
    const first = renderToStaticMarkup(<GlobalCapControl />);
    const second = renderToStaticMarkup(<GlobalCapControl />);
    expect(words(first)).toContain('9 di 17');
    expect(words(second)).toContain('9 di 17');
    expect(first).toContain('value="17"');
    expect(second).toContain('value="17"');
  });

  test('in auto the ceiling is the machine’s, not the fallback number', () => {
    // Il numero fisso resta 5 sotto, ma in auto non è lui a valere: mostrarlo
    // sarebbe la bugia comoda (il dispatcher applica `recommended`).
    adoptGlobalCap({ maxAgentsAuto: true, maxAgents: 5 });
    adoptDispatchCapacity(machine({ recommended: 2, running: 1 }));
    expect(words(renderToStaticMarkup(<GlobalCapControl />))).toContain('1 di 2');
  });

  test('when the cap is full it SAYS so: that is why the queue is not moving', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 2 });
    adoptDispatchCapacity(machine({ running: 2 }));
    const html = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(html).toContain('2 di 2');
    expect(html).toContain('Tetto pieno');
  });

  test('nothing full about a cap with room left', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 6 });
    adoptDispatchCapacity(machine({ running: 1 }));
    expect(words(renderToStaticMarkup(<GlobalCapControl />))).not.toContain('Tetto pieno');
  });

  // Running CAN exceed the cap, and every case above is running <= cap, so the
  // wording was only ever asserted on one side. In `auto` the denominator is the
  // live machine recommendation and it drops with load; a fixed cap can be typed
  // lower than the number of turns already going. Nothing is killed to fit.
  test('above the cap it does not read "4 di 2"', () => {
    adoptGlobalCap({ maxAgentsAuto: true, maxAgents: 5 });
    adoptDispatchCapacity(machine({ recommended: 2, running: 4 }));
    const html = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(html).not.toContain('4 di 2');
    expect(html).toContain('4 al lavoro, tetto 2');
  });

  test('above the cap it says why it will settle, not that it is merely full', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 2 });
    adoptDispatchCapacity(machine({ running: 5 }));
    const html = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(html).toContain('Sopra il tetto');
    expect(html).not.toContain('Tetto pieno');
  });

  // "No ceiling" is a fixed cap of zero. Every line that prints the limit has to
  // survive an infinite one, and the first one that would not is this: a bare
  // interpolation puts the word "Infinity" in front of the person.
  test('with no ceiling it says so, and never prints Infinity', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 0 });
    adoptDispatchCapacity(machine({ running: 8 }));
    const html = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(html).toContain('8 al lavoro, nessun tetto');
    expect(html).not.toContain('Infinity');
  });

  test('with no ceiling nothing is full: there is nothing to be full of', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 0 });
    adoptDispatchCapacity(machine({ running: 40 }));
    const html = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(html).not.toContain('Tetto pieno');
    expect(html).not.toContain('Sopra il tetto');
  });

  test('the three modes are three, and exactly one is chosen', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 0 });
    const off = renderToStaticMarkup(<GlobalCapControl />);
    expect(off.match(/aria-checked="true"/g) ?? []).toHaveLength(1);
    expect(words(off)).toContain('Nessun limite');
    // And the fixed-number box is not shown in a mode that has no number.
    expect(off).not.toContain('data-testid="global-cap-max"');

    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 6 });
    const fixed = renderToStaticMarkup(<GlobalCapControl />);
    expect(fixed.match(/aria-checked="true"/g) ?? []).toHaveLength(1);
    expect(fixed).toContain('value="6"');
  });

  test('the zero of "no ceiling" never leaks into the number box', () => {
    // 0 is a sentinel, not a quantity: showing it would offer "zero agents",
    // which is the one setting nobody can want.
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 0 });
    expect(renderToStaticMarkup(<GlobalCapControl />)).not.toContain('value="0"');
  });

  test('exactly at the cap is full, not over', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 3 });
    adoptDispatchCapacity(machine({ running: 3 }));
    const html = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(html).toContain('3 di 3');
    expect(html).toContain('Tetto pieno');
    expect(html).not.toContain('Sopra il tetto');
  });
});

describe('both surfaces mount it, and neither writes on its own', () => {
  const src = (file: string) => readFileSync(join(import.meta.dir, file), 'utf8');

  // PAINTED, not merely present. The cap block moved into its own light module
  // exactly so this could be a render: a regex over the source cannot tell
  // `<GlobalCapControl />` from `{false && <GlobalCapControl />}`, and the
  // falsification "I removed the tag and the test went red" then only proves the
  // string is gone, not that anything is drawn.
  test('the settings panel of a board WITHOUT a project draws the cap', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 7 });
    adoptDispatchCapacity(machine({ running: 2 }));
    const html = words(renderToStaticMarkup(
      <GlobalOnlySettingsPanel dispatchOn onToggleDispatch={() => {}} onClose={() => {}} />,
    ));
    // This is the case that regressed in the first place: on the general board
    // the panel was behind `hasProject`, so there was no panel and the cap was
    // back to living only in the ▾.
    expect(html).toContain('2 di 7');
    expect(html).toContain('Agent in parallelo');
  });

  test('the machine-wide section carries the cap wherever a panel mounts it', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 4 });
    adoptDispatchCapacity(machine({ running: 1 }));
    const html = words(renderToStaticMarkup(
      <GlobalSettingsSection dispatchOn={false} onToggleDispatch={() => {}} />,
    ));
    expect(html).toContain('1 di 4');
  });

  // The two heavy surfaces stay on a source check, and the header says why:
  // `TaskDetail.tsx` and `KanbanBoardPane.tsx` cannot be mounted here. What is
  // asserted is narrower than before, though — that each one renders the shared
  // section/control, which is the single thing that would have to be deleted for
  // the cap to vanish from that surface.
  test('the board settings panel goes through the shared machine-wide section', () => {
    // `BoardSettingsPanel.tsx`, non piu' `TaskDetail.tsx`: il pannello e' uscito
    // dal cassetto della card il 14/08 (configurava il PROGETTO, non un TASK).
    // Il test guarda il sorgente e non il render perche' quel pannello qui non
    // si monta: se un giorno diventasse montabile, questo controllo va sostituito
    // da un render vero, che e' piu' forte.
    const s = src('BoardSettingsPanel.tsx');
    expect(/<GlobalSettingsSection[\s/>]/.test(s)).toBe(true);
    expect(/from '\.\/BoardSettingsSections'/.test(s)).toBe(true);
  });

  test('the header ▾ menu draws the cap through this component', () => {
    const s = src('KanbanBoardPane.tsx');
    expect(/<GlobalCapControl[\s/>]/.test(s)).toBe(true);
    expect(/from '\.\/GlobalCapControl'/.test(s)).toBe(true);
  });

  test('the ⚙ is not gated on having a project, or the general board loses it', () => {
    // The button and the panel are one gesture: gating either on `hasProject`
    // is what made the cap unreachable from settings on the general board.
    const s = src('KanbanBoardPane.tsx');
    expect(/showSettings && hasProject/.test(s)).toBe(false);
    expect(/<GlobalOnlySettingsPanel[\s/>]/.test(s)).toBe(true);
  });

  test('ONE writer: no surface calls setGlobalCap behind the store', () => {
    // È la parte che tiene ferma la promessa «un cambio in uno si vede
    // nell'altro»: appena una superficie si riprende la scrittura, si riprende
    // anche il proprio stato, e i due numeri ricominciano a divergere.
    for (const file of ['TaskDetail.tsx', 'KanbanBoardPane.tsx', 'GlobalCapControl.tsx']) {
      expect(src(file).includes('setGlobalCap')).toBe(false);
    }
  });
});
