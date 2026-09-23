/**
 * THE CAP IS VISIBLE, AND THE TWO SURFACES SHOW ONE SINGLE ONE OF IT.
 *
 * The promise is the one made by whoever uses the app: «there must be no global
 * cap other than the one viewable from the board settings». So, two things, and
 * neither of them is held up by the compiler:
 *
 *  1. the control DRAWS the two numbers (how many at work, out of how many),
 *     taken from the store and not from a copy of its own;
 *  2. BOTH surfaces really do mount it, the title's ▾ menu and the settings
 *     panel, and neither of the two talks to the server on its own account.
 *
 * Point 2 is checked on the SOURCE, with the same method (and the same reason)
 * as `ThreadRuns.test.tsx`: `TaskDetail.tsx` and `KanbanBoardPane.tsx` pull in
 * the API, the pane layout and a dozen stores, so they do not mount in a unit
 * test, and «the surface has stopped calling it» is a one-line change. `bun
 * test` does not even resolve the `@/` alias those files use.
 *
 * (jsdom/happy-dom are not dependencies of this project, as
 * `ThreadRuns.test.tsx` says: the mounting is `renderToStaticMarkup`.)
 *
 * @covers KANBAN-07, KANBAN-12
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { GlobalCapControl } from './GlobalCapControl';
import { checksFloorBoxValue } from './dispatchLoad';
import { GlobalOnlySettingsPanel, GlobalSettingsSection } from './BoardSettingsSections';
import { adoptChecksFloor, adoptDispatchCapacity, adoptGlobalCap } from '../../state/globalDispatchCap';
import type { DispatchCapacity } from '../../lib/board';

const machine = (over: Partial<DispatchCapacity> = {}): DispatchCapacity => ({
  recommended: 4,
  cores: 12,
  totalMemGB: 32,
  // Measured (20 GB free of 32): `null` would be "no probe", which is another
  // case with a test of its own.
  availableMemGB: 20,
  load1: 2.5,
  // La misura che comanda il tetto: quanta CPU tiene la NOSTRA flotta, e quanta
  // gliene spetta (metà dei 12 core). Il `load1` qui sopra è rimasto per la
  // modalità notturna e per gli host senza sonda, non è più il freno.
  oursCores: 0,
  budgetCores: 6,
  // The budget half of the reading: 80% of this machine, nothing of ours
  // running yet. Every case below moves the fields it is about.
  budgetShare: 0.8,
  budgetCoreUnits: 9.6,
  agentCostMemGB: 1.5,
  freeQuotaMemGB: 16,
  usableCoreUnits: 9.6,
  usedCoreUnits: 0,
  usedMemGB: 1,
  otherCoreUnits: 0,
  frozen: 0,
  reason: '12 core, base 4',
  running: 0,
  ...over,
});

/** Il testo che una persona legge, senza i tag. */
function words(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  // The brake too: the store is module state, and a frame that omits the mode
  // KEEPS the one it has (that is the contract for an old server), so a test
  // that switched to `resources` would otherwise leak into the next one.
  adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 5, maxAgentsMode: 'count' });
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

  /** The chosen one of the THREE count states, by test id. There are two radio
   *  groups now (which brake, then which count state), so a bare count of
   *  `aria-checked="true"` would say two and mean nothing. */
  const chosenState = (html: string) => html.match(/aria-checked="true" data-testid="global-cap-mode-[a-z]+"/g) ?? [];

  test('the three modes are three, and exactly one is chosen', () => {
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 0 });
    const off = renderToStaticMarkup(<GlobalCapControl />);
    expect(chosenState(off)).toHaveLength(1);
    expect(words(off)).toContain('Nessun limite');
    // And the fixed-number box is not shown in a mode that has no number.
    expect(off).not.toContain('data-testid="global-cap-max"');

    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 6 });
    const fixed = renderToStaticMarkup(<GlobalCapControl />);
    expect(chosenState(fixed)).toHaveLength(1);
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

/**
 * THE OTHER BRAKE (KANBAN-75): one budget in per cent of this computer. What is
 * drawn, what is NOT drawn, and that the numbers come from the capacity reading
 * rather than from a copy of it.
 */
describe('the brake by budget', () => {
  const resources = (share = 0.8) =>
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 5, maxAgentsMode: 'resources', budgetShare: share });

  test('an old server, or a fresh row, is the brake by count', () => {
    // No mode on the wire = `count` (the store's default when it has none, see
    // `globalDispatchCap.test.ts`), and NOTHING of the other brake is drawn: the
    // slider would be a promise the dispatcher on that server cannot keep.
    adoptGlobalCap({ maxAgentsAuto: false, maxAgents: 5 });
    const html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toContain('aria-checked="true" data-testid="global-cap-brake-count"');
    expect(html).not.toContain('data-testid="global-cap-budget-slider"');
    expect(html).toContain('data-testid="global-cap-max"');
  });

  test('by budget the fixed number is not drawn: it does not apply, so it is not shown', () => {
    resources();
    adoptDispatchCapacity(machine({ running: 3 }));
    const html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toContain('aria-checked="true" data-testid="global-cap-brake-resources"');
    expect(html).not.toContain('data-testid="global-cap-max"');
    expect(html).not.toContain('data-testid="global-cap-mode-');
    expect(html).toContain('data-testid="global-cap-budget-slider"');
    // The count is still there: it is the live term, not the cap.
    expect(words(html)).toContain('3 agent al lavoro');
    expect(words(html)).not.toContain('3 di 5');
  });

  test('the knob shows the share the gate applies, clamped and defaulted', () => {
    // 9 is far above the bound; the wire never reaches the slider unclamped.
    resources(9);
    let html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toMatch(/data-testid="global-cap-budget-value">95% del libero</);
    adoptGlobalCap({ maxAgentsMode: 'resources', budgetShare: 0.8 });
    html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toMatch(/data-testid="global-cap-budget-value">80% del libero</);
  });

  test('the percentage is said in the units it buys, on both axes', () => {
    resources(0.8);
    adoptDispatchCapacity(machine({ cores: 12, totalMemGB: 32 }));
    const html = renderToStaticMarkup(<GlobalCapControl />);
    expect(words(html)).toContain('12 core');
    expect(words(html)).toContain('9.6 core-unità');
    expect(words(html)).toContain('26 GB');
  });

  test('the live reading is coloured against the budget, and says the numbers', () => {
    resources(0.8);
    // 2 core-units of a 9.6 budget: far from it, green.
    adoptDispatchCapacity(machine({ usedCoreUnits: 2, budgetCoreUnits: 9.6, usableCoreUnits: 9.6 }));
    let html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toContain('data-testid="global-cap-budget-live" data-band="green"');
    expect(words(html)).toContain('Topics usa 2.0 dei 9.6 core a disposizione');
    // At the budget: red.
    adoptDispatchCapacity(machine({ usedCoreUnits: 9.6, budgetCoreUnits: 9.6, usableCoreUnits: 9.6 }));
    html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toContain('data-testid="global-cap-budget-live" data-band="red"');
  });

  test('a budget squeezed by the rest of the machine shows the smaller number, not the ceiling', () => {
    // Others hold most of the machine: 2 of the 9.6 core-units are usable, and
    // that is the number said, because it is the one the gate admits against.
    resources(0.8);
    adoptDispatchCapacity(machine({ usedCoreUnits: 1, budgetCoreUnits: 9.6, usableCoreUnits: 2 }));
    const html = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(html).toContain('Topics usa 1.0 dei 2.0 core a disposizione');
    expect(html).not.toContain('dei 9.6 core a disposizione');
  });

  test('the reading is said ONCE, and the explanations are folded away', () => {
    // The panel said the same use three times (running line, live line,
    // summary line) with four paragraphs around it. One live line now, and
    // the how-it-works under a closed disclosure.
    resources(0.8);
    adoptDispatchCapacity(machine({ usedCoreUnits: 2, usableCoreUnits: 5, running: 2, frozen: 1 }));
    const html = renderToStaticMarkup(<GlobalCapControl />);
    expect(words(html).match(/core a disposizione/g)).toHaveLength(1);
    expect(html).not.toContain('% del PC');
    const details = html.match(/<details[^>]*data-testid="global-cap-details"[^>]*>([\s\S]*?)<\/details>/);
    expect(details).not.toBe(null);
    expect(details![0]).not.toMatch(/<details[^>]*\sopen/);
    const folded = words(details![1]);
    expect(folded).toContain('i processi che non sono di Topics hanno la precedenza');
    expect(folded).toContain('Un tetto solo');
    expect(folded).toContain('1 check congelati');
  });

  test('not measured is said, not shown as an empty machine', () => {
    resources();
    adoptDispatchCapacity(machine({ usedCoreUnits: null }));
    const html = renderToStaticMarkup(<GlobalCapControl />);
    expect(words(html)).toContain('Leggo la macchina');
    expect(html).toContain('data-testid="global-cap-budget-live" data-band="none"');
  });

  test('nothing usable is the red end, not a missing threshold', () => {
    // The others hold the whole machine: usable 0 is a measured ceiling, and
    // falling back to the budget drew green numbers beside a gate that refused.
    resources(0.6);
    adoptDispatchCapacity(machine({ usedCoreUnits: 1.2, budgetCoreUnits: 7.2, usableCoreUnits: 0, running: 2 }));
    const html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toContain('data-testid="global-cap-budget-live" data-band="red"');
    expect(words(html)).toContain('Topics usa 1.2 dei 0.0 core a disposizione');
  });

  test('the verdict is the GATE\'s, read off the wire, and says which axis holds', () => {
    // A client-side `used >= usable` said "would start" at 3.4 of 3.8 while the
    // gate, pricing one more agent at 0.5, was holding. Whatever the numbers,
    // the line says what `admission` says.
    resources(0.6);
    adoptDispatchCapacity(machine({ usedCoreUnits: 3.4, usableCoreUnits: 3.8, running: 2,
      admission: { admit: false, blockedBy: 'cpu', firstAgentExempt: false, costCoreUnits: 0.5 } }));
    let html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toContain('data-testid="global-cap-verdict" data-admit="false" data-blocked-by="cpu"');
    expect(words(html)).toContain('In attesa');

    // An old server sends the axis without its numbers: the axis is said, and
    // nothing claims the memory is "full" (it held that night with 7 GB free).
    adoptDispatchCapacity(machine({ usedCoreUnits: 1, usableCoreUnits: 9.6, running: 3,
      admission: { admit: false, blockedBy: 'memory', firstAgentExempt: false, costCoreUnits: 0.5 } }));
    html = renderToStaticMarkup(<GlobalCapControl />);
    // cores:12, load1:2.5 -> 21% CPU; totalMemGB:32, availableMemGB:20 -> 38% memory.
    expect(words(html)).toContain('In attesa: il Mac è al 38% di memoria');
    expect(words(html)).not.toContain('memoria piena');

    adoptDispatchCapacity(machine({ usedCoreUnits: 2, usableCoreUnits: 9.6, running: 2,
      admission: { admit: true, blockedBy: null, firstAgentExempt: false, costCoreUnits: 0.5 } }));
    html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toContain('data-admit="true"');
    expect(words(html)).toContain('un agent nuovo partirebbe');

    // The exemption is said as one, not as a free machine.
    adoptDispatchCapacity(machine({ usedCoreUnits: 9.7, usableCoreUnits: 9.6, running: 0,
      admission: { admit: true, blockedBy: 'cpu', firstAgentExempt: true, costCoreUnits: 0.5 } }));
    html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toContain('data-admit="true"');
    expect(words(html)).toContain('il primo parte comunque');
  });

  test('the verdict names the axis WITH the numbers it compared', () => {
    resources(0.6);
    // The quota clause: one more agent does not fit in our share of the free.
    adoptDispatchCapacity(machine({ usedCoreUnits: 1, usableCoreUnits: 6.6, running: 3,
      admission: { admit: false, blockedBy: 'memory', firstAgentExempt: false, costCoreUnits: 0.5,
        costMemGB: 4, freeQuotaMemGB: 3.3, ourMemGB: 9, usableMemGB: 12.3, memClause: 'quota' } }));
    // memClause 'quota' has no honest resume threshold: the current reading only.
    let html = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(html).toContain('In attesa: il Mac è al 38% di memoria');
    // The footprint clause (two 11 GB shard runs): the ceiling as a share of
    // the whole Mac IS the honest resume threshold (20.4/32 = 64%).
    adoptDispatchCapacity(machine({ usedCoreUnits: 4, usableCoreUnits: 6.6, running: 16,
      admission: { admit: false, blockedBy: 'memory', firstAgentExempt: false, costCoreUnits: 0.5,
        costMemGB: 1.5, freeQuotaMemGB: 4.2, ourMemGB: 22, usableMemGB: 20.4, memClause: 'footprint' } }));
    html = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(html).toContain('In attesa: il Mac è al 38% di memoria, parte da solo sotto il 64%');
    // The CPU: one more agent would still not fit under the ceiling, cost alone.
    adoptDispatchCapacity(machine({ usedCoreUnits: 3.4, usableCoreUnits: 3.8, running: 2,
      admission: { admit: false, blockedBy: 'cpu', firstAgentExempt: false, costCoreUnits: 0.5, usedCoreUnits: 3.4, usableCoreUnits: 3.8 } }));
    expect(words(renderToStaticMarkup(<GlobalCapControl />))).toContain('In attesa: CPU alta, un agent in più ne costerebbe il 4%');
  });

  // THE NIGHT OF 14/09: 5.5 GB available under the native 6 GB floor, the only
  // brake that held, while the panel said in green that an agent would start.
  test('the floor holds: the panel says so with its numbers, in either brake', () => {
    const floor = { admit: false, blockedBy: 'floor' as const, firstAgentExempt: false, costCoreUnits: 0,
      reason: 'Memoria quasi finita: 5.5 GB disponibili, sotto il pavimento di 6 GB. Con il runtime nativo i check ne chiedono ~1,5 GB.' };
    resources(0.6);
    adoptDispatchCapacity(machine({ usedCoreUnits: 2, usableCoreUnits: 6.6, running: 3, admission: floor }));
    let html = renderToStaticMarkup(<GlobalCapControl />);
    expect(html).toContain('data-testid="global-cap-verdict" data-admit="false" data-blocked-by="floor"');
    expect(words(html)).toContain('In attesa: memoria quasi finita, 5.5 GB disponibili, sotto il pavimento di 6 GB');
    expect(words(html)).not.toContain('partirebbe');

    // By count there is no budget verdict, but "3 di 4" must not stand alone.
    adoptGlobalCap({ maxAgentsAuto: true, maxAgents: 5, maxAgentsMode: 'count' });
    adoptDispatchCapacity(machine({ recommended: 4, running: 3, admission: floor }));
    html = renderToStaticMarkup(<GlobalCapControl />);
    expect(words(html)).toContain('3 di 4');
    expect(html).toContain('data-blocked-by="floor"');
    expect(words(html)).toContain('sotto il pavimento di 6 GB');
  });

  test('the live number is the one the gate decided on, turns still warming up included', () => {
    // The probe says 2.0; the gate counts the three turns it admitted a minute
    // ago and holds at 6.5 of 6.6. One line, one count.
    resources(0.6);
    adoptDispatchCapacity(machine({ usedCoreUnits: 2, usableCoreUnits: 6.6, running: 5,
      admission: { admit: false, blockedBy: 'cpu', firstAgentExempt: false, costCoreUnits: 1.5,
        usedCoreUnits: 6.5, usableCoreUnits: 6.6, pendingAdmissions: 3 } }));
    const html = renderToStaticMarkup(<GlobalCapControl />);
    expect(words(html)).toContain('Topics usa 6.5 dei 6.6 core a disposizione (3 appena partiti)');
    expect(words(html)).not.toContain('usa 2.0');
    expect(html).toContain('data-testid="global-cap-budget-live" data-band="amber"');
  });

  test('no admission on the wire (an old server): no verdict is drawn, rather than a guessed one', () => {
    resources(0.8);
    adoptDispatchCapacity(machine({ usedCoreUnits: 2, usableCoreUnits: 9.6, running: 2 }));
    expect(renderToStaticMarkup(<GlobalCapControl />)).not.toContain('data-testid="global-cap-verdict"');
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

  // Il ▾ accanto al titolo non c'e' piu': era il SECONDO ingresso alle stesse
  // impostazioni, con una copia sua dello stato dell'auto-dispatch. Restano il
  // ⚙ e il suo pannello, che montano il blocco condiviso (asserito sopra come
  // render vero). Quello che qui va tenuto fermo e' che la testata non si
  // ricrei una porta propria: niente cap montato a mano fuori dal pannello,
  // niente lettura/scrittura dell'interruttore globale per conto suo.
  test('ONE settings door: the header does not mount the cap on its own', () => {
    const s = src('KanbanBoardPane.tsx');
    expect(/<GlobalCapControl[\s/>]/.test(s)).toBe(false);
    expect(/from '\.\/GlobalCapControl'/.test(s)).toBe(false);
    // UNA sola lettura dell'interruttore globale in tutta la barra: quella che
    // alimenta lo stato passato al pannello. Due letture erano due copie, ed e'
    // il difetto per cui il ▾ mostrava «spento» mentre il pannello diceva
    // «acceso».
    expect(s.split('getGlobalDispatch').length - 1).toBe(1);
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

describe('the checks memory floor field', () => {
  test('the value comes from the store, and 0 is drawn as 0 and not as an empty box', () => {
    // 0 is a setting — the brake off — so it has to paint as a number. An empty
    // box is reserved for "not read yet", which is a different state entirely.
    adoptChecksFloor({ checksMemFloorGB: 4 });
    expect(renderToStaticMarkup(<GlobalCapControl />)).toContain('data-testid="checks-floor-gb"');
    expect(renderToStaticMarkup(<GlobalCapControl />)).toContain('value="4"');
    adoptChecksFloor({ checksMemFloorGB: 0 });
    expect(renderToStaticMarkup(<GlobalCapControl />)).toContain('value="0"');
  });

  test('at 0 the hint says the brake is OFF, in words', () => {
    // A numeric field that changes meaning at one end has to say so. Without
    // this line the only way to learn what 0 does is to read the server.
    adoptChecksFloor({ checksMemFloorGB: 0 });
    const off = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(off).toContain('Freno spento');
    adoptChecksFloor({ checksMemFloorGB: 3 });
    const on = words(renderToStaticMarkup(<GlobalCapControl />));
    expect(on).not.toContain('Freno spento');
    // And the hint names the load the number is calibrated against, which is
    // the one fact that lets somebody move it on purpose instead of by feel.
    expect(on).toContain('lint a freddo: 1,9 GB');
  });

  test('not read yet paints an EMPTY box, 0 paints a zero', () => {
    // The distinction the store cannot show once it has adopted anything: the
    // module store lives between tests, so this is held down on the function
    // the box calls rather than on a mounted component.
    expect(checksFloorBoxValue(null)).toBe('');
    expect(checksFloorBoxValue(0)).toBe('0');
    expect(checksFloorBoxValue(3)).toBe('3');
    // A draft under the finger wins over both, empty draft included: somebody
    // clearing the box to type must not have a value put back under them.
    expect(checksFloorBoxValue(3, '')).toBe('');
    expect(checksFloorBoxValue(null, '7')).toBe('7');
  });

  test('the field is drawn whichever brake the cap is on: it gates checks, not agents', () => {
    adoptChecksFloor({ checksMemFloorGB: 3 });
    adoptGlobalCap({ maxAgentsMode: 'count' });
    expect(renderToStaticMarkup(<GlobalCapControl />)).toContain('data-testid="checks-floor-gb"');
    adoptGlobalCap({ maxAgentsMode: 'resources' });
    expect(renderToStaticMarkup(<GlobalCapControl />)).toContain('data-testid="checks-floor-gb"');
  });
});
