/**
 * Gate dello shim di rete (LAN-PAIR-01).
 *
 * Perché questo test esiste. La prima versione del pairing attaccava il token in
 * due posti — `api.ts::request` e lo shim globale — e lo shim era gated su
 * `!isTauri → esci`. Ma nel client ci sono ~80 chiamate `fetch('/api/…')`, 46
 * mutanti, sparse in oltre 20 file, e le più calde (sync del pane-store, dei
 * tombstone, del layout di progetto, delle tab del browser del task) usano
 * `fetch` NUDO con header propri, perché devono aggiungere `X-Client-Id` e usare
 * `keepalive`: non passano da `api.ts`. Su Tauri lo shim le copriva; sulla PWA in
 * LAN — l'UNICO caso per cui il token esiste — non si installava affatto, quindi
 * tutte partivano senza token e prendevano 401. Cioè esattamente la rottura che
 * LAN-PAIR-01 doveva chiudere, in un percorso che nessun test toccava.
 *
 * Il test fissa il gate su entrambi i lati: con un token memorizzato lo shim si
 * installa anche fuori da Tauri e il token arriva su una fetch nuda; senza token
 * NON si installa (nessun monkey-patch sul browser locale, che è la condizione
 * "byte-identica a prima" su cui si regge il percorso loopback fidato).
 *
 * `bun test` non ha un DOM: si stubbano a mano i global che i moduli toccano
 * (`localStorage`, `fetch`, `EventSource`). `isTauri` è una costante calcolata al
 * caricamento del modulo e senza i global di Tauri vale sempre 'web' — che è il
 * lato che ci interessa.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { __resetNetShimForTests, installNetShim } from './net';

const TOKEN = 'b'.repeat(64);
const STORAGE_KEY = 'topics.pairingToken';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

type Call = { url: string; headers: Headers };

let calls: Call[];
let originalFetch: typeof globalThis.fetch | undefined;

function stubEnv(): void {
  const w = globalThis as unknown as {
    window?: unknown;
    localStorage?: unknown;
    fetch?: unknown;
    EventSource?: unknown;
  };
  const storage = new MemoryStorage();
  calls = [];
  const spy = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    calls.push({ url, headers: new Headers(init?.headers as HeadersInit | undefined) });
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof globalThis.fetch;

  const win = {
    localStorage: storage,
    fetch: spy,
    // EventSource assente: lo shim salta quel ramo (`if (OrigES)`) e il test
    // resta sul percorso fetch, che è quello dei 46 callsite mutanti.
    EventSource: undefined,
  };
  w.window = win;
  w.localStorage = storage;
  w.fetch = spy;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  __resetNetShimForTests();
  stubEnv();
});

afterEach(() => {
  __resetNetShimForTests();
  if (originalFetch) (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
});

describe('installNetShim · gate', () => {
  test('con un token memorizzato si installa anche fuori da Tauri, e una fetch NUDA porta il token', async () => {
    const w = globalThis as unknown as { window: { localStorage: MemoryStorage; fetch: typeof fetch } };
    w.window.localStorage.setItem(STORAGE_KEY, TOKEN);

    installNetShim();

    // Una chiamata come quelle di syncServer.ts: fetch nuda, header propri,
    // nessun passaggio da api.ts.
    await w.window.fetch('/api/ui-state/pane-store-v2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'tab-1' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('x-topics-token')).toBe(TOKEN);
    // Gli header che il callsite metteva di suo NON vengono persi: perderli
    // romperebbe il sync (il server usa X-Client-Id per `sourceClientId`).
    expect(calls[0]!.headers.get('X-Client-Id')).toBe('tab-1');
    expect(calls[0]!.headers.get('Content-Type')).toBe('application/json');
    // Su web l'URL non si riscrive: serverHttpBase() è '' fuori da Tauri.
    expect(calls[0]!.url).toBe('/api/ui-state/pane-store-v2');
  });

  test('senza token NON si installa: nessun monkey-patch sul percorso locale fidato', async () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    const before = w.window.fetch;

    installNetShim();

    expect(w.window.fetch).toBe(before);
    await w.window.fetch('/api/topics');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('x-topics-token')).toBeNull();
  });

  test('installazione idempotente: due chiamate non impilano due wrapper', async () => {
    const w = globalThis as unknown as { window: { localStorage: MemoryStorage; fetch: typeof fetch } };
    w.window.localStorage.setItem(STORAGE_KEY, TOKEN);

    installNetShim();
    const afterFirst = w.window.fetch;
    installNetShim();

    expect(w.window.fetch).toBe(afterFirst);
    await w.window.fetch('/api/topics');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('x-topics-token')).toBe(TOKEN);
  });
});
