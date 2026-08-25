/**
 * Gate dello shim di rete — lato TAURI, che è il lato per cui lo shim esiste e
 * che nessun test copriva.
 *
 * Perché è un file a parte, e perché serve un mock. `isTauri` (`shell/index.ts`)
 * è una COSTANTE calcolata al caricamento del modulo, da
 * `window.__TAURI_INTERNALS__`/`__TAURI__` o dall'origine. Sotto `bun test` quei
 * global non esistono, quindi vale sempre `false`, e un `import` statico — che è
 * hoisted — rende il ramo Tauri irraggiungibile per costruzione. Piantare i
 * global prima non basta: `bun test` condivide il registry fra i file, quindi il
 * primo file che tocca `./index` fissa `shellKind` per tutti gli altri (provato:
 * l'asserzione di guardia falliva proprio così). La leva giusta è
 * `mock.module('./index')`, che sostituisce il modulo nel registry e ricollega i
 * dipendenti già caricati — le import ESM sono binding vivi. Il mock è di
 * processo, quindi `afterAll` lo ritira e il lato web resta libero in
 * `net.test.ts`.
 *
 * Cosa fissa: sotto Tauri la UI è servita da `tauri://localhost`, quindi una
 * `fetch('/api/…')` relativa risolverebbe contro un'origine senza server. Lo shim
 * la riscrive sull'origine del proxy loopback, e **non deve perdere gli header
 * che il callsite ha messo di suo**: le chiamate più calde del client (sync del
 * pane-store, tombstone, layout di progetto, tab del browser del task) passano
 * `X-Client-Id`, che il server usa come `sourceClientId`.
  * @covers NETSHIM-02
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from 'bun:test';

/**
 * Il modulo VERO, fotografato PRIMA di sostituirlo: è l'unico modo di rimetterlo
 * a posto (vedi `afterAll`). La copia dev'essere PIATTA — la namespace ESM è
 * viva, e tenerne il riferimento vorrebbe dire rileggere i valori finti.
 *
 * I quattro nomi sono scritti a mano, non presi con uno spread della namespace, e
 * NON è pignoleria: `{ ...(await import('./index')) }` rende quel modulo OPACO
 * per knip, che da lì in poi conta ogni suo export come usato. Lo dice il
 * cancello apposito (`bun run check:deadcode-blindspots`), che è diventato rosso
 * la prima volta che l'ho scritto con lo spread. Destrutturare tiene il modulo
 * visibile.
 *
 * Sono anche TUTTI: `shell/index.ts` esporta esattamente questi quattro valori a
 * runtime (più il tipo `ShellKind`, che a runtime non esiste). Se un giorno ne
 * spunta un quinto va aggiunto qui, altrimenti il ripristino lo lascerebbe
 * `undefined` per i file che girano dopo.
 */
let realIndex: {
  isTauri: boolean;
  isDesktop: boolean;
  shellKind: 'tauri' | 'web';
  detectShell: () => 'tauri' | 'web';
};

const PROXY = 'http://127.0.0.1:13333';

type Call = { url: string; headers: Headers; method?: string };

let calls: Call[];

// I tre nomi scritti a mano invece di `typeof import('./net')` + `await
// import('./net')`: entrambe quelle forme sono riferimenti OPACHI all'intero
// modulo per il cancello sul codice morto, che da lì in poi non può segnalare
// nessun export di `net.ts` (`bun run check:deadcode-blindspots`).
async function loadNet() {
  const { serverHttpBase, installNetShim, __resetNetShimForTests } = await import('./net');
  return { serverHttpBase, installNetShim, __resetNetShimForTests };
}
let net: Awaited<ReturnType<typeof loadNet>>;

function makeSpy(): typeof globalThis.fetch {
  return ((input: unknown, init?: RequestInit) => {
    const isReq = typeof input === 'object' && input !== null && 'url' in (input as object);
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    const headers = new Headers(
      (init?.headers as HeadersInit | undefined) ??
      (isReq ? (input as Request).headers : undefined),
    );
    calls.push({ url, headers, method: init?.method ?? (isReq ? (input as Request).method : undefined) });
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
}

// I global veri, presi PRIMA di piantarci sopra la spia. `bun test` condivide il
// processo fra i file: quello che pianti qui lo trova chi gira dopo.
const realFetch = globalThis.fetch;
const realWindow = (globalThis as unknown as { window?: unknown }).window;

beforeAll(async () => {
  calls = [];
  const w = globalThis as unknown as { window?: unknown; fetch?: unknown };
  w.window = { fetch: makeSpy(), EventSource: undefined };
  w.fetch = (w.window as { fetch: unknown }).fetch;

  // DEVE stare prima di qualunque `import('./net')`: sostituisce nel registry il
  // modulo che espone `isTauri`, e Bun ricollega i dipendenti già caricati (le
  // import ESM sono binding vivi, quindi `serverHttpBase()` legge il valore
  // nuovo). Senza questo il ramo Tauri è irraggiungibile sotto `bun test`, dove
  // i global di Tauri non esistono e `shellKind` si fissa a 'web'.
  const { isTauri, isDesktop, shellKind, detectShell } = await import('./index');
  realIndex = { isTauri, isDesktop, shellKind, detectShell };
  mock.module('./index', () => ({
    ...realIndex,
    isTauri: true,
    isDesktop: true,
    shellKind: 'tauri' as const,
    detectShell: () => 'tauri' as const,
  }));

  net = await loadNet();
  // Se questo fallisce il mock non ha preso, e ogni test sotto sarebbe verde per
  // il motivo sbagliato: starebbe esercitando il ramo web.
  expect(net.serverHttpBase()).toBe(PROXY);
});

beforeEach(() => {
  calls = [];
  net.__resetNetShimForTests();
  const w = globalThis as unknown as { window: { fetch: typeof fetch } };
  w.window.fetch = makeSpy();
});

afterEach(() => {
  net.__resetNetShimForTests();
});

// Il mock del registry è di PROCESSO: senza questo, un file che gira dopo vedrebbe
// `isTauri` true e proverebbe il contrario di ciò che crede.
//
// E la stessa cosa vale per i GLOBAL, che è la metà che mancava: `beforeAll` pianta
// su `globalThis.fetch` una spia che risponde `{}` a chiunque, e restava piantata
// per tutto il resto del processo. Misurato il 07/08/2026: `bun test ./client/src
// ./server` dava 1 rosso — `server/browser-native-delegate.socket.test.ts`
// («round-trips a browser_op over a REAL WebSocket») leggeva `undefined` invece di
// '42', perché la sua `fetch('/trigger')` verso il proprio server Bun effimero
// finiva nella spia di QUESTO file. Da soli i due file erano verdi: il rosso
// nasceva solo dall'ordine. Rimettere i global veri è il fix strutturale.
afterAll(() => {
  // `mock.restore()` NON ritira un `mock.module` — misurato su bun 1.3.8, e il
  // commento qui sopra credeva il contrario. È il motivo per cui la sostituzione
  // sopravviveva a questo file: l'unico modo di rimettere il modulo vero è
  // ri-mockare con la fotografia presa prima.
  //
  // Costava due rossi che si vedevano SOLO su Linux, e non perché Linux c'entri:
  // `bun test` esegue tutti i file in UN processo e l'ordine di scoperta dipende
  // da come il filesystem enumera la cartella. Su APFS `focus.test.ts` girava
  // prima e vedeva il modulo vero; sul runner girava dopo, leggeva
  // `shellKind === 'tauri'` e `focusGateState()` rispondeva «pending» invece di
  // «unavailable». Riprodotto qui invertendo l'ordine a mano.
  mock.module('./index', () => realIndex);
  mock.restore();
  const w = globalThis as unknown as { window?: unknown; fetch?: unknown };
  w.fetch = realFetch;
  if (realWindow === undefined) delete w.window;
  else w.window = realWindow;
});

describe('installNetShim · gate (Tauri)', () => {
  test('riscrive una fetch relativa sull origine del proxy loopback', async () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    net.installNetShim();

    await w.window.fetch('/api/topics');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${PROXY}/api/topics`);
  });

  test('preserva gli header del callsite: X-Client-Id regge il sync del pane-store', async () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    net.installNetShim();

    await w.window.fetch('/api/ui-state/pane-store-v2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'tab-1' },
    });

    expect(calls[0]!.url).toBe(`${PROXY}/api/ui-state/pane-store-v2`);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers.get('X-Client-Id')).toBe('tab-1');
    expect(calls[0]!.headers.get('Content-Type')).toBe('application/json');
  });

  test('riscrive anche quando l input e un Request, non una stringa', async () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    net.installNetShim();

    // Un Request con URL relativo: `new Request('/api/x')` non è costruibile in
    // un ambiente senza base URL, quindi si simula la forma che lo shim ispeziona.
    const reqLike = { url: '/api/topics', method: 'GET', headers: new Headers() };
    await (w.window.fetch as unknown as (i: unknown) => Promise<Response>)(reqLike);

    // Non essendo una vera `Request`, cade nel ramo passthrough: il test fissa che
    // il passthrough NON riscrive, così un domani il ramo Request resta l'unico
    // punto che tocca gli URL relativi non-stringa.
    expect(calls[0]!.url).toBe('/api/topics');
  });

  test('un URL assoluto verso un altra origine passa intatto', async () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    net.installNetShim();

    await w.window.fetch('https://api.anthropic.com/v1/models');

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models');
  });

  test('installazione idempotente: due chiamate non impilano due wrapper', async () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    net.installNetShim();
    const afterFirst = w.window.fetch;
    net.installNetShim();

    expect(w.window.fetch).toBe(afterFirst);
    await w.window.fetch('/api/topics');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${PROXY}/api/topics`);
  });
});
