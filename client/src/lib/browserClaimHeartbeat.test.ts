/**
 * Il cancello del battito di reclamo.
 *
 * Perché servono i mock, e perché stanno in cima al file. `isTauri`
 * (`shell/index.ts`) è una COSTANTE calcolata al caricamento del modulo: sotto
 * `bun test` i global di Tauri non esistono, quindi vale sempre `false` e il
 * ramo che conta sarebbe irraggiungibile per costruzione. La leva è
 * `mock.module`, che sostituisce il modulo nel registry e ricollega i
 * dipendenti già caricati, perché le import ESM sono binding vivi. Vale anche
 * a mezzo file: `setShell(false)` fa vedere al modulo sotto test un mondo
 * senza Tauri senza ricaricarlo. Il mock è di PROCESSO, quindi `afterAll` lo
 * ritira e chi gira dopo ritrova il suo `isTauri` vero.
 *
 * I timer sono finti nello stesso senso: `setInterval` diventa un registro di
 * battiti che si fa scattare a mano. Non è una comodità, è l'unico modo di
 * chiedere «quanti battiti hai armato?», che è la domanda su cui poggia
 * l'idempotenza.
 *
 * Cosa fissa. Il reclamo è ciò che tiene VIVE le webview: se questa finestra
 * smette di parlare, o parla del pane sbagliato, il Rust chiude roba che
 * l'utente sta guardando. Quindi conta il contenuto del messaggio (label giusto
 * e id vivi), conta che parta subito, e conta che un errore resti un battito
 * perso invece di diventare un'eccezione che uccide il bootstrap.
  * @covers CLAIM-01
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { markBrowserViewLive, markBrowserViewDead } from './shell/nativeBrowserRoster';

type Invoke = { cmd: string; args?: Record<string, unknown> };

let invokes: Invoke[] = [];
let invokeResult: () => Promise<number> = () => Promise.resolve(0);
let windowLabel: string | null = 'main';

/** Riscrive `./shell` nel registry. Chiamabile a metà file: il modulo sotto
 *  test legge `isTauri` al momento della chiamata, non al caricamento. */
function setShell(tauri: boolean): void {
  mock.module('./shell', () => ({
    isTauri: tauri,
    isDesktop: tauri,
    shellKind: tauri ? ('tauri' as const) : ('web' as const),
    detectShell: () => (tauri ? ('tauri' as const) : ('web' as const)),
  }));
}

setShell(true);
mock.module('./shell/tauri', () => ({
  currentWindowLabel: () => windowLabel,
  tauriInvoke: (cmd: string, args?: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    return invokeResult();
  },
  releaseNativeFocus: () => {},
}));

// Dinamica e con i nomi scritti a mano: dev'essere DOPO i mock, e un
// `typeof import(...)` sarebbe un riferimento opaco per il cancello sul codice
// morto, che da lì in poi non vedrebbe più nessun export di questo modulo.
const {
  BROWSER_CLAIM_INTERVAL_MS,
  claimBrowserViews,
  scheduleBrowserClaimHeartbeat,
  __resetBrowserClaimHeartbeatForTests,
} = await import('./browserClaimHeartbeat');

/** I battiti armati: `{ms}` dice il passo, `fn()` fa scattare quel giro. */
let beats: Array<{ fn: () => void; ms: number }> = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

/** Gli id piantati nel roster VERO da un test, da togliere dopo: è un Set di
 *  modulo, e quello che ci resta dentro entra nel test seguente. */
let planted: string[] = [];
function plant(...ids: string[]): void {
  for (const id of ids) { markBrowserViewLive(id); planted.push(id); }
}

/** Lascia girare le microtask: `claimBrowserViews` è async, e il suo `invoke`
 *  parte prima del primo await, ma il risultato no. */
const tick = () => Promise.resolve();

beforeEach(() => {
  invokes = [];
  beats = [];
  planted = [];
  windowLabel = 'main';
  invokeResult = () => Promise.resolve(0);
  setShell(true);
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    beats.push({ fn, ms });
    return beats.length;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof globalThis.clearInterval;
  __resetBrowserClaimHeartbeatForTests();
});

afterEach(() => {
  for (const id of planted) markBrowserViewDead(id);
  planted = [];
  __resetBrowserClaimHeartbeatForTests();
  // I global veri rimessi SUBITO: `bun test` condivide il processo fra i file,
  // e un `setInterval` finto lasciato in giro non arma più niente per nessuno.
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

// Il mock è di processo: senza questo, un file che gira dopo crederebbe di
// essere dentro Tauri e proverebbe il contrario di quello che pensa.
afterAll(() => { mock.restore(); });

describe('claimBrowserViews', () => {
  test('manda il label di QUESTA finestra e gli id delle pane vive', async () => {
    windowLabel = 'detach-7';
    plant('ctx-a', 'ctx-b');

    expect(await claimBrowserViews()).toBe(0);

    expect(invokes).toHaveLength(1);
    expect(invokes[0]!.cmd).toBe('browser_claim');
    expect(invokes[0]!.args?.window).toBe('detach-7');
    expect([...(invokes[0]!.args?.ids as string[])].sort()).toEqual(['ctx-a', 'ctx-b']);
  });

  /**
   * Senza label si reclama per `main`. Non è una formalità: un `undefined` al
   * posto del nome farebbe cadere il reclamo su una finestra che non esiste, e
   * le pane di questa resterebbero non rivendicate da nessuno.
   */
  test('finestra senza label: il reclamo va comunque a main', async () => {
    windowLabel = null;
    plant('ctx-solo');

    await claimBrowserViews();

    expect(invokes[0]!.args?.window).toBe('main');
  });

  test('nessuna pane montata: si reclama la lista VUOTA, non si tace', async () => {
    // Tacere e dire «non ho niente» sono due cose diverse per il Rust: la
    // seconda è ciò che gli lascia chiudere le webview di un pop-out svuotato.
    await claimBrowserViews();

    expect(invokes).toHaveLength(1);
    expect(invokes[0]!.args?.ids).toEqual([]);
  });

  test('fuori da Tauri non si invoca niente', async () => {
    setShell(false);
    plant('ctx-a');

    expect(await claimBrowserViews()).toBe(-1);
    expect(invokes).toHaveLength(0);
  });

  test('un invoke che rigetta non esplode: battito perso, -1, e si va avanti', async () => {
    invokeResult = () => Promise.reject(new Error('comando assente nel guscio vecchio'));
    plant('ctx-a');

    expect(await claimBrowserViews()).toBe(-1);
    expect(invokes).toHaveLength(1);
  });
});

describe('scheduleBrowserClaimHeartbeat', () => {
  test('batte SUBITO, poi ogni 15 secondi', async () => {
    plant('ctx-a');

    scheduleBrowserClaimHeartbeat();
    await tick();

    // Il battito immediato è la metà che conta all'avvio di una finestra.
    expect(invokes).toHaveLength(1);
    expect(invokes[0]!.args?.ids).toEqual(['ctx-a']);
    expect(beats).toHaveLength(1);
    expect(beats[0]!.ms).toBe(15_000);
    expect(beats[0]!.ms).toBe(BROWSER_CLAIM_INTERVAL_MS);
  });

  test('è un battito, non un giro solo: ogni scatto rivendica di nuovo', async () => {
    plant('ctx-a');
    scheduleBrowserClaimHeartbeat();
    await tick();

    beats[0]!.fn();
    beats[0]!.fn();
    await tick();

    expect(invokes).toHaveLength(3);
  });

  test("e rivendica quello che è vivo ADESSO, non la lista dell'armo", async () => {
    plant('ctx-a');
    scheduleBrowserClaimHeartbeat();
    await tick();

    plant('ctx-b');
    markBrowserViewDead('ctx-a');
    beats[0]!.fn();
    await tick();

    expect([...(invokes[1]!.args?.ids as string[])]).toEqual(['ctx-b']);
  });

  test('idempotente: armarlo due volte non raddoppia i battiti', async () => {
    scheduleBrowserClaimHeartbeat();
    scheduleBrowserClaimHeartbeat();
    await tick();

    expect(beats).toHaveLength(1);
    // E nemmeno il battito immediato si sdoppia.
    expect(invokes).toHaveLength(1);
  });

  test('fuori da Tauri non arma nessun battito', async () => {
    setShell(false);

    scheduleBrowserClaimHeartbeat();
    await tick();

    expect(beats).toHaveLength(0);
    expect(invokes).toHaveLength(0);
  });
});
