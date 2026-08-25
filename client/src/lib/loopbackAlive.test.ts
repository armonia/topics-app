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
 *
 * @covers BROWSER-01
   */
  test('server irraggiungibile, 500 o risposta senza il campo ⇒ si prova comunque', async () => {
    stubFetch(() => { throw new Error('offline'); });
    expect(await loopbackAlive('http://localhost:3210/')).toBe(true);

    stubFetch(() => new Response('nope', { status: 500 }));
    expect(await loopbackAlive('http://localhost:3210/')).toBe(true);

    stubFetch(() => Response.json({ port: 3210 }));
    expect(await loopbackAlive('http://localhost:3210/')).toBe(true);
  });

  /**
   * Il tetto conta più della risposta: la pane resta su «Initializing native
   * browser…» finché questa promessa non si risolve, quindi un server di Topics
   * impallato o in riavvio bloccherebbe la scheda per sempre. Una sonda nata per
   * evitare un fastidio non può diventare un blocco.
   */
  test('server che non risponde mai: si smette di aspettare e si prova a caricare', async () => {
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await loopbackAlive('http://localhost:3210/', 50)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});
