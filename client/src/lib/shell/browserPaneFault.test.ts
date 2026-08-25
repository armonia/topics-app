/**
 * Recognising a browser pane that has faulted, and recreating it.
 *
 * @covers BROWSER-01
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  NO_FAULT, FAULT_STREAK, STRUCTURAL_COMMANDS, recordPaneOk, recordPaneError, recreatePane,
  type FaultState, type PaneRecreateSteps,
} from './browserPaneFault';

/** Feed n failures of the same command through the reducer. */
function fail(times: number, command = 'browser_set_bounds', from: FaultState = NO_FAULT): FaultState {
  let s = from;
  for (let i = 0; i < times; i++) s = recordPaneError(s, command);
  return s;
}

describe('browserPaneFault', () => {
  it('one failure is not a broken pane', () => {
    // A command can race the pane's own teardown, or land between a deferred
    // close and the reopen that cancels it. Faulting on the first rejection
    // would put an error strip over a pane that is about to be fine.
    const s = fail(1);
    expect(s.faulted).toBe(false);
    expect(s.streak).toBe(1);
  });

  it('a streak is', () => {
    // A poisoned dispatcher mutex never recovers: it fails the next one too.
    const s = fail(FAULT_STREAK);
    expect(s.faulted).toBe(true);
    expect(s.streak).toBe(FAULT_STREAK);
  });

  it('names the command that tipped it over', () => {
    expect(fail(FAULT_STREAK, 'browser_navigate').command).toBe('browser_navigate');
  });

  it('a single success clears the streak', () => {
    expect(recordPaneOk(fail(FAULT_STREAK - 1))).toEqual(NO_FAULT);
  });

  it('a success clears the fault too — only a REPLACED view can answer again', () => {
    const broken = fail(FAULT_STREAK);
    expect(broken.faulted).toBe(true);
    expect(recordPaneOk(broken)).toEqual(NO_FAULT);
  });

  it('returns the SAME object when a success changes nothing', () => {
    // The hook compares by identity to avoid a setState per successful
    // set_bounds — and set_bounds fires on every frame of a drag.
    const s = recordPaneOk(NO_FAULT);
    expect(s).toBe(NO_FAULT);
  });

  it('non-structural failures neither accuse the pane nor absolve it', () => {
    // A page can hang on its own; a hung PAGE is not a broken pane.
    const half = fail(FAULT_STREAK - 1);
    const after = recordPaneError(half, 'browser_eval_js');
    expect(after).toBe(half);
    expect(after.faulted).toBe(false);
  });

  it('does not count the commands with a legitimate failure mode', () => {
    // eval/screenshot: a page can stall. animate_bounds: "this shell doesn't
    // have the command" is a capability answer. open/close: lifecycle, already
    // surfaced by the bounded-retry path at mount.
    for (const cmd of [
      'browser_eval_js', 'browser_exec_js', 'browser_screenshot',
      'browser_animate_bounds', 'browser_open', 'browser_close',
    ]) {
      expect(STRUCTURAL_COMMANDS.has(cmd)).toBe(false);
    }
  });

  it('counts the ones a poisoned dispatcher kills wholesale', () => {
    for (const cmd of [
      'browser_set_bounds', 'browser_navigate', 'browser_reload',
      'browser_back', 'browser_forward', 'browser_set_visible',
      'browser_set_user_agent', 'browser_go_to_index',
    ]) {
      expect(STRUCTURAL_COMMANDS.has(cmd)).toBe(true);
    }
  });

  it('the threshold is reachable by the command that fires most often', () => {
    // browser_set_bounds runs per frame during a drag, so the streak completes
    // in well under a second — no timer needed to tell permanent from transient.
    expect(STRUCTURAL_COMMANDS.has('browser_set_bounds')).toBe(true);
    expect(FAULT_STREAK).toBeGreaterThan(1);
  });
});

/**
 * «Ricrea la scheda» — il rimedio che la striscia di guasto offre, nel caso per
 * cui la striscia esiste: il dispatcher col mutex avvelenato, dove la vista non
 * si lascia nemmeno chiudere.
 */
describe('recreatePane', () => {
  /** Registra l'ordine dei passi e permette di far fallire quello che serve. */
  function steps(over: { closeFails?: boolean; openFails?: boolean } = {}) {
    const calls: string[] = [];
    const s: PaneRecreateSteps = {
      close: async () => { calls.push('close'); return !over.closeFails; },
      open: async () => { calls.push('open'); return !over.openFails; },
      handshake: () => { calls.push('handshake'); },
      onLabelBurned: () => { calls.push('burned'); },
    };
    return { s, calls };
  }

  it('si riapre ANCHE dopo una chiusura fallita — è lì che serve', async () => {
    // La catena del guasto: close() panica sul mutex avvelenato, la vista resta
    // registrata nel manager, e senza riapertura la pane resta com'era. Il
    // guscio brucia l'etichetta proprio perché la riapertura che segue nasca
    // come vista NUOVA invece di riusare la morta.
    const { s, calls } = steps({ closeFails: true });
    expect(await recreatePane(s)).toBe(true);
    expect(calls).toEqual(['close', 'burned', 'open', 'handshake']);
  });

  it('la chiusura riuscita non segnala nessuna etichetta bruciata', async () => {
    const { s, calls } = steps();
    expect(await recreatePane(s)).toBe(true);
    expect(calls).toEqual(['close', 'open', 'handshake']);
  });

  it('si chiude PRIMA di riaprire', async () => {
    const { s, calls } = steps();
    await recreatePane(s);
    expect(calls.indexOf('close')).toBeLessThan(calls.indexOf('open'));
  });

  it('niente vista nuova, niente stretta di mano: il guasto resta scritto', async () => {
    // Il vecchio `commitFault(NO_FAULT)` in testa faceva sparire la striscia
    // qualunque cosa succedesse dopo: «risolto» per un attimo, poi il guasto
    // tornava dopo altri tre fallimenti. Solo la vista nuova può assolvere.
    const { s, calls } = steps({ openFails: true });
    expect(await recreatePane(s)).toBe(false);
    expect(calls).not.toContain('handshake');
  });

  /**
   * Il pezzo che vive in React non è provabile qui (niente jsdom né renderer di
   * hook in questo progetto), ma il CABLAGGIO sì — stessa tecnica di
   * `nativeBrowserOpen.test.ts`. È ciò che è tornato a rompersi una volta:
   * `recreate` che azzera il guasto da sé e butta via l'esito della chiusura.
   */
  it('il pulsante passa di qui, e non assolve la pane per conto suo', () => {
    const src = readFileSync(new URL('../../hooks/useTauriBrowser.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const recreate ='), src.indexOf('const viewId ='));
    expect(body).toContain('recreatePane({');
    expect(body).toContain("tauriInvoke('browser_close'");
    // L'esito della chiusura si legge (niente `.catch(() => {})` che lo ingoia)…
    expect(body).not.toContain('.catch(() => {})');
    // …e il guasto non si azzera a mano: lo cancella la vista nuova.
    expect(body).not.toContain('commitFault(NO_FAULT)');
    expect(body).toContain('handshake:');
  });

  it('è la stretta di mano a cancellare il guasto, non la ricreazione in sé', () => {
    // Chi ricrea non tocca lo stato del guasto: lo cancella `recordPaneOk`
    // quando un comando strutturale sulla vista nuova risponde davvero.
    const broken = recordPaneError(recordPaneError(recordPaneError(NO_FAULT, 'browser_set_bounds'), 'browser_set_bounds'), 'browser_set_bounds');
    expect(broken.faulted).toBe(true);
    expect(recordPaneOk(broken)).toEqual(NO_FAULT);
  });
});
