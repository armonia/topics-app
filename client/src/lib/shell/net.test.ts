/**
 * Gate dello shim di rete — lato WEB.
 *
 * Lo shim esiste per riscrivere gli URL relativi verso l'origine del data server,
 * e serve solo sotto Tauri (dove la UI vive su `tauri://localhost`). Fuori da
 * Tauri `serverHttpBase()` è `''`: riscrivere sarebbe un no-op, quindi lo shim
 * NON si installa e il browser resta senza monkey-patch. Questo file fissa quel
 * lato; il ramo Tauri sta in `net.tauri.test.ts`, che deve stubbare i global
 * PRIMA dell'import perché `isTauri` è una costante calcolata al caricamento del
 * modulo.
 *
 * Storia, perché il gate è delicato in entrambe le direzioni. Per un periodo lo
 * shim portava anche il token di pairing, e allora si installava anche su web —
 * era l'unico modo di coprire le ~80 chiamate `fetch('/api/…')` (46 mutanti, in
 * oltre 20 file) che usano `fetch` NUDO con header propri (`X-Client-Id`,
 * `keepalive`) e non passano da `api.ts::request`. Il token non esiste più, ma
 * quel fatto resta: questo è l'unico choke point che le vede tutte, ed è dove
 * andrà attaccato l'header di sessione dell'autenticazione centralizzata.
 *
 * `bun test` non ha un DOM: si stubbano a mano i global che i moduli toccano.
  * @covers NETSHIM-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { __resetNetShimForTests, installNetShim } from './net';

type Call = { url: string; headers: Headers };

let calls: Call[];
let originalFetch: typeof globalThis.fetch | undefined;

function stubEnv(): void {
  const w = globalThis as unknown as { window?: unknown; fetch?: unknown };
  calls = [];
  const spy = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    calls.push({ url, headers: new Headers(init?.headers as HeadersInit | undefined) });
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as unknown as typeof globalThis.fetch;

  w.window = { fetch: spy, EventSource: undefined };
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
  // The stub window too: bun has none, and a partial one left behind flips the
  // `typeof window` guards of the next file in this process.
  delete (globalThis as { window?: unknown }).window;
});

describe('installNetShim · gate (web)', () => {
  test('fuori da Tauri NON si installa: nessun monkey-patch, e l URL resta relativo', async () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    const before = w.window.fetch;

    installNetShim();

    expect(w.window.fetch).toBe(before);
    await w.window.fetch('/api/topics');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/topics');
  });

  test('non attacca piu alcun header di token: il pairing e stato rimosso', async () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    installNetShim();
    await w.window.fetch('/api/ui-state/pane-store-v2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'tab-1' },
    });
    expect(calls[0]!.headers.get('x-topics-token')).toBeNull();
    // Gli header del callsite restano intatti: perderli romperebbe il sync, che
    // usa X-Client-Id come `sourceClientId` lato server.
    expect(calls[0]!.headers.get('X-Client-Id')).toBe('tab-1');
  });

  test('installazione idempotente anche quando e un no-op', () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    const before = w.window.fetch;
    installNetShim();
    installNetShim();
    expect(w.window.fetch).toBe(before);
  });
});
