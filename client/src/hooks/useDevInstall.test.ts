/**
 * A FAILED PROBE IS NOT AN ANSWER.
 *
 * The probe is memoized for the life of the document, and a 5xx or a network
 * error at boot used to be memoized too, as a definitive `false`: the dev-only
 * surfaces stayed hidden until a reload. Only a real answer is kept now.
 *
 * @covers SYSTEM-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { whenDevInstallKnown, __resetDevInstallForTests } from './useDevInstall';

const realFetch = globalThis.fetch;
beforeEach(() => { __resetDevInstallForTests(); });
afterEach(() => { globalThis.fetch = realFetch; __resetDevInstallForTests(); });

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})) as unknown as typeof fetch;

describe('whenDevInstallKnown', () => {
  test('a 5xx at boot answers «no» now and asks again next time', async () => {
    globalThis.fetch = answer(503, { error: 'restarting' });
    expect(await whenDevInstallKnown()).toBe(false);
    globalThis.fetch = answer(200, { server: { devReload: true } });
    expect(await whenDevInstallKnown()).toBe(true);
  });

  test('a network error is retried the same way', async () => {
    globalThis.fetch = (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
    expect(await whenDevInstallKnown()).toBe(false);
    globalThis.fetch = answer(200, { server: { devReload: true } });
    expect(await whenDevInstallKnown()).toBe(true);
  });

  test('a real answer is kept: no second request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ server: { devReload: false } })); }) as unknown as typeof fetch;
    expect(await whenDevInstallKnown()).toBe(false);
    expect(await whenDevInstallKnown()).toBe(false);
    expect(calls).toBe(1);
  });
});
