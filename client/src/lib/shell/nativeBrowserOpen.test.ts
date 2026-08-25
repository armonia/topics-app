/**
 * Lo spinner immortale della pane nativa.
 *
 * `navigate` su scheda parcheggiata, il «Riprova» del parcheggio e `recreate`
 * accendono la barra di caricamento e poi chiedono la view a `openViewRef`,
 * che non restituisce niente. I tre punti che SPENGONO la barra
 * (`useTauriBrowser`: i due poll e il drain nav-error) stanno dentro effetti
 * che partono con `if (!ready) return`: se `browser_open` fallisce, `ready`
 * non diventa mai vero e la barra resta accesa per sempre — con il rollup di
 * progetto che conta la pane occupata a vita.
 *
 * Il ramo della resa è quindi l'unico posto che vede il fallimento e copre
 * tutti e tre i chiamanti. Qui si presidia che quel ramo ci arrivi davvero (e
 * non prima del tempo: un fallimento transitorio si ritenta ancora).
 *
 * @covers BROWSER-CHAT-04
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { attemptNativeOpen } from './nativeBrowserOpen';

/** Il pezzo di hook che ci interessa: chi accende la barra, e cosa la spegne. */
function paneUnderTest(invoke: () => Promise<unknown>, opts: { cancelled?: boolean } = {}) {
  const state = { loading: true, navError: null as string | null, opened: false };
  // Le due scadenze del ritentativo scattano subito: il test non aspetta 400ms.
  const pending: Array<() => void> = [];
  attemptNativeOpen({
    invoke,
    isCancelled: () => opts.cancelled === true,
    onOpened: () => { state.opened = true; },
    onGaveUp: () => {
      state.navError = 'Impossibile aprire il browser nativo. Riprova.';
      state.loading = false;
    },
    schedule: (fn) => { pending.push(fn); },
  });
  return { state, flush: async () => { while (pending.length) { pending.shift()!(); await Promise.resolve(); await Promise.resolve(); } } };
}

describe('attemptNativeOpen', () => {
  test('browser_open che rifiuta sempre: la barra si spegne, con la strip d’errore', async () => {
    let calls = 0;
    const pane = paneUnderTest(() => { calls++; return Promise.reject(new Error('poisoned mutex')); });
    await Promise.resolve();
    await Promise.resolve();
    // Primo giro fallito: si ritenta, quindi la barra è ancora legittimamente accesa.
    expect(calls).toBe(1);
    expect(pane.state.loading).toBe(true);

    await pane.flush();
    expect(calls).toBe(2);
    expect(pane.state.opened).toBe(false);
    expect(pane.state.navError).toBe('Impossibile aprire il browser nativo. Riprova.');
    expect(pane.state.loading).toBe(false);
  });

  test('il singhiozzo transitorio si ricuce al secondo giro: nessuna resa', async () => {
    let calls = 0;
    const pane = paneUnderTest(() => (++calls === 1 ? Promise.reject(new Error('hiccup')) : Promise.resolve()));
    await Promise.resolve();
    await Promise.resolve();
    await pane.flush();
    expect(calls).toBe(2);
    expect(pane.state.opened).toBe(true);
    expect(pane.state.navError).toBe(null);
  });

  test('pane smontata a metà: non si tocca più lo stato di nessuno', async () => {
    const pane = paneUnderTest(() => Promise.reject(new Error('nope')), { cancelled: true });
    await Promise.resolve();
    await Promise.resolve();
    await pane.flush();
    expect(pane.state.navError).toBe(null);
    expect(pane.state.opened).toBe(false);
  });
});

/**
 * Il pezzo che vive in React non è provabile qui: in questo progetto non ci
 * sono jsdom/happy-dom né un renderer di hook, quindi `loading` di
 * `useTauriBrowser` non si può leggere. Ciò che si può presidiare — e che è
 * esattamente il difetto — è il CABLAGGIO: che la resa spenga la barra, e che
 * i tre chiamanti che l'accendono passino dal punto che sa spegnerla quando la
 * view non si può nemmeno chiedere. Stessa tecnica di
 * `tests/unit/single-door.test.ts`.
 */
describe('useTauriBrowser: il cablaggio della barra di caricamento', () => {
  const src = readFileSync(new URL('../../hooks/useTauriBrowser.ts', import.meta.url), 'utf8');

  test('il ramo della resa spegne `loading` accanto alla strip d’errore', () => {
    const gaveUp = src.slice(src.indexOf('onGaveUp:'), src.indexOf('onGaveUp:') + 700);
    expect(src).toContain('onGaveUp:');
    expect(gaveUp).toContain('setNavError(');
    expect(gaveUp).toContain('setLoading(false)');
  });

  test('nessuno chiede la view direttamente a `openViewRef` dopo aver acceso la barra', () => {
    // L'effetto di montaggio SCRIVE la ref; a leggerla per aprire deve essere
    // solo `requestOpenView`, che sa spegnere la barra se la ref è morta.
    const readsOutsideHelper = [...src.matchAll(/openViewRef\.current\?\.\(/g)];
    expect(readsOutsideHelper.length).toBe(0);
    expect(src).toContain('const requestOpenView');
  });
});
