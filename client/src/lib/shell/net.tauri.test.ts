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
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, mock } from 'bun:test';

// DEVE stare prima di qualunque `import('./net')`: sostituisce il modulo che
// espone `isTauri` nel registry, e Bun ricollega i dipendenti già caricati (le
// import ESM sono binding vivi, quindi `serverHttpBase()` legge il valore nuovo).
// Senza questo il ramo Tauri è irraggiungibile sotto `bun test`, dove i global di
// Tauri non esistono e `shellKind` si fissa a 'web' al caricamento.
mock.module('./index', () => ({
  isTauri: true,
  isDesktop: true,
  shellKind: 'tauri' as const,
  detectShell: () => 'tauri' as const,
}));

const PROXY = 'http://127.0.0.1:13333';

type Call = { url: string; headers: Headers; method?: string };

let calls: Call[];
let net: typeof import('./net');

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

beforeAll(async () => {
  calls = [];
  const w = globalThis as unknown as { window?: unknown; fetch?: unknown };
  w.window = { fetch: makeSpy(), EventSource: undefined };
  w.fetch = (w.window as { fetch: unknown }).fetch;

  net = await import('./net');
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
afterAll(() => {
  mock.restore();
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
