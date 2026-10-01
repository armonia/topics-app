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
 * The door for `/api` is NOT this shim: it is `apiFetch`, called explicitly by
 * every `/api` callsite on every platform (`bun run check:api-door` keeps it
 * that way). The second half of this file pins what the door adds on the web,
 * where the shim is absent: the identity refusal, with nothing the callsite
 * sends or reads changed.
 *
 * `bun test` non ha un DOM: si stubbano a mano i global che i moduli toccano.
  * @covers NETSHIM-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { __resetNetShimForTests, apiFetch, installNetShim } from './net';
import { __resetSessionForTests, getSession } from '../auth/session';

type Call = { url: string; headers: Headers; init?: RequestInit };

let calls: Call[];
/** What the stubbed server answers next. */
let answer: () => Response;
let originalFetch: typeof globalThis.fetch | undefined;

function stubEnv(): void {
  const w = globalThis as unknown as { window?: unknown; fetch?: unknown };
  calls = [];
  answer = () => new Response('{}', { status: 200 });
  const spy = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    calls.push({ url, headers: new Headers(init?.headers as HeadersInit | undefined), init });
    return Promise.resolve(answer());
  }) as unknown as typeof globalThis.fetch;

  w.window = { fetch: spy, EventSource: undefined };
  w.fetch = spy;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  __resetNetShimForTests();
  __resetSessionForTests();
  stubEnv();
});

afterEach(() => {
  __resetNetShimForTests();
  __resetSessionForTests();
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

const refusal = (status: number, body: unknown) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('apiFetch · the door (web)', () => {
  test('sends exactly what the callsite wrote: same relative URL, same init object', async () => {
    const init: RequestInit = {
      method: 'PUT',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'tab-1' },
      body: '{"a":1}',
    };
    const res = await apiFetch('/api/ui-state/pane-store-v2?base=3', init);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/ui-state/pane-store-v2?base=3');
    // The very object: nothing added, nothing dropped, keepalive included.
    expect(calls[0]!.init).toBe(init);
    expect(calls[0]!.headers.get('X-Client-Id')).toBe('tab-1');
    expect(res.status).toBe(200);
  });

  test('a 401 from the identity gate flips the session, and the caller still reads the body', async () => {
    answer = refusal(401, { error: 'device revoked', code: 'device_revoked' });
    expect(getSession().status).toBe('loading');

    const res = await apiFetch('/api/ui-state/pane-store-v2', { method: 'PUT', body: '{}' });

    const s = getSession();
    expect(s.status).toBe('unpaired');
    if (s.status === 'unpaired') expect(s.reason).toBe('revoked');
    // The door read a clone: the callsite's own read of the body still works.
    expect(await res.json()).toEqual({ error: 'device revoked', code: 'device_revoked' });
  });

  test('an expired session reads as expired, a missing one as not paired', async () => {
    answer = refusal(401, { error: 'session expired', code: 'session_expired' });
    await apiFetch('/api/topics/streaming');
    let s = getSession();
    expect(s.status === 'unpaired' && s.reason).toBe('expired');

    __resetSessionForTests();
    answer = refusal(401, { error: 'device not paired', code: 'device_not_paired' });
    await apiFetch('/api/topics/streaming');
    s = getSession();
    expect(s.status === 'unpaired' && s.reason).toBe('not_paired');
  });

  test('a permission refusal, a 401 without a code and a non-JSON 401 leave the session alone', async () => {
    for (const make of [
      refusal(401, { error: 'nope', code: 'forbidden' }),
      refusal(401, { error: 'nope' }),
      refusal(401, '<html>proxy</html>'),
      refusal(403, { error: 'nope', code: 'device_revoked' }),
    ]) {
      answer = make;
      const res = await apiFetch('/api/projects');
      expect(res.status).toBeGreaterThanOrEqual(401);
      expect(getSession().status).toBe('loading');
    }
  });

  test('a raw fetch does not get the door: that is what check:api-door is for', async () => {
    const w = globalThis as unknown as { window: { fetch: typeof fetch } };
    installNetShim();
    answer = refusal(401, { error: 'device revoked', code: 'device_revoked' });
    await w.window.fetch('/api/projects');
    expect(getSession().status).toBe('loading');
  });
});
