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
import { adoptDispatchCapacity, adoptGlobalCap } from '../../state/globalDispatchCap';
import type { DispatchCapacity } from '../../lib/board';

const machine = (over: Partial<DispatchCapacity> = {}): DispatchCapacity => ({
  recommended: 4,
  cores: 12,
  totalMemGB: 32,
  load1: 2.5,
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
});

describe('both surfaces mount it, and neither writes on its own', () => {
  const src = (file: string) => readFileSync(join(import.meta.dir, file), 'utf8');

  test('the board settings panel draws the cap through this component', () => {
    const s = src('TaskDetail.tsx');
    // Il confine conta: `<GlobalCapControlQualcosaltro` non deve passare.
    expect(/<GlobalCapControl[\s/>]/.test(s)).toBe(true);
    expect(/from '\.\/GlobalCapControl'/.test(s)).toBe(true);
  });

  test('the header ▾ menu draws the cap through this component', () => {
    const s = src('KanbanBoardPane.tsx');
    expect(/<GlobalCapControl[\s/>]/.test(s)).toBe(true);
    expect(/from '\.\/GlobalCapControl'/.test(s)).toBe(true);
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
