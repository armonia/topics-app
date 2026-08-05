import { afterEach, describe, expect, test } from 'bun:test';
import { loopbackAlive } from './loopbackAlive';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(impl: () => Promise<Response> | Response) {
  // `as unknown as`: allo stub manca `fetch.preconnect`, che a nessuno qui serve.
  globalThis.fetch = (async () => impl()) as unknown as typeof fetch;
}

describe('loopbackAlive', () => {
  test('una URL non loopback non si sonda nemmeno: non è affar nostro', async () => {
    let called = false;
    stubFetch(() => { called = true; return new Response('{}'); });
    expect(await loopbackAlive('https://example.com/')).toBe(true);
    expect(called).toBe(false);
  });

  test('porta in ascolto ⇒ viva, porta spenta ⇒ morta', async () => {
    stubFetch(() => Response.json({ port: 3333, listening: true }));
    expect(await loopbackAlive('http://localhost:3333/')).toBe(true);
    stubFetch(() => Response.json({ port: 3210, listening: false }));
    expect(await loopbackAlive('http://localhost:3210/')).toBe(false);
  });

  /**
   * La proprietà che conta. Un falso «è morta» parcheggia una scheda VIVA e fa
   * sembrare rotto il pannello; un falso «è viva» al massimo ci fa provare a
   * caricare, che è il comportamento di sempre. Nel dubbio si prova.
   */
  test('server irraggiungibile, 500 o risposta senza il campo ⇒ si prova comunque', async () => {
    stubFetch(() => { throw new Error('offline'); });
    expect(await loopbackAlive('http://localhost:3210/')).toBe(true);

    stubFetch(() => new Response('nope', { status: 500 }));
    expect(await loopbackAlive('http://localhost:3210/')).toBe(true);

    stubFetch(() => Response.json({ port: 3210 }));
    expect(await loopbackAlive('http://localhost:3210/')).toBe(true);
  });
});
