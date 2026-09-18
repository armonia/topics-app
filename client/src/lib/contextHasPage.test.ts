/**
 * The seed's discriminant, pinned.
 *
 * The case that matters most here is the third one: a context already sitting
 * on the very url the seed wants to load must read as "in use". That is the
 * regression this helper exists for - comparing the local strings said "not
 * loaded yet" there, and the seed reloaded a live page.
 *
 * @covers BROWSER-CHAT-04
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { contextHasPage } from './contextHasPage';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Answer every request with this status/body, and record what was asked. */
function stubFetch(status: number, body?: unknown): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { calls };
}

describe('contextHasPage', () => {
  test('404 means no context at all, so the seed must run', async () => {
    stubFetch(404);
    expect(await contextHasPage('ctx-1')).toBe(false);
  });

  test('a context parked on about:blank is not in use', async () => {
    stubFetch(200, { url: 'about:blank' });
    expect(await contextHasPage('ctx-1')).toBe(false);
  });

  test('a context with no url yet is not in use', async () => {
    stubFetch(200, { url: '' });
    expect(await contextHasPage('ctx-1')).toBe(false);
  });

  test('a context ALREADY ON THE SEED URL is in use, and must not be reloaded', async () => {
    const seedUrl = 'http://127.0.0.1:4321/';
    stubFetch(200, { url: seedUrl });
    expect(await contextHasPage('ctx-1')).toBe(true);
  });

  test('a context on some other page is in use', async () => {
    stubFetch(200, { url: 'https://example.com/' });
    expect(await contextHasPage('ctx-1')).toBe(true);
  });

  test('the context id is asked for by id, url-encoded', async () => {
    const { calls } = stubFetch(404);
    await contextHasPage('a/b c');
    expect(calls[0]).toBe('/api/browsers/a%2Fb%20c');
  });

  test('an unreadable answer leaves the context alone', async () => {
    stubFetch(500);
    expect(await contextHasPage('ctx-1')).toBe(true);
  });

  test('a network error leaves the context alone', async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await contextHasPage('ctx-1')).toBe(true);
  });

  test('a fetch that never answers stops at the ceiling, leaving it alone', async () => {
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    expect(await contextHasPage('ctx-1', 20)).toBe(true);
  });
});
