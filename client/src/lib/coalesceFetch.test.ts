/**
 * @covers BOOT-NET-01
 */
import { describe, expect, test } from 'bun:test';
import { createFetchCoalescer } from './coalesceFetch';

/** A fetch the test controls: it counts calls and settles when told to. */
function fakeNetwork() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let pending: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  const fetcher = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
  };
  return {
    calls,
    fetcher,
    /** Settle every request in flight with the same body. */
    answer(body: string, status = 200) {
      const due = pending; pending = [];
      for (const p of due) p.resolve(new Response(status === 204 ? null : body, { status, headers: { 'content-type': 'application/json' } }));
    },
    fail(err: unknown) {
      const due = pending; pending = [];
      for (const p of due) p.reject(err);
    },
    get inFlight() { return pending.length; },
  };
}

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance(ms: number) { t += ms; } };
}

/** Let the promise chain behind `coalescer.fetch` run to completion. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('coalescedFetch — one request per URL in flight', () => {
  test('five callers of the same URL in the same tick cost ONE network request, and each gets its own readable body', async () => {
    const net = fakeNetwork();
    const c = createFetchCoalescer({ fetcher: net.fetcher, identity: () => 'same' });
    const answers = Array.from({ length: 5 }, () => c.fetch('/api/ui-state/claude-prefs-skip'));
    expect(net.calls.length).toBe(1);
    net.answer('{"value":true}');
    const bodies = await Promise.all(answers.map(async (p) => (await p).json()));
    expect(bodies).toEqual(Array.from({ length: 5 }, () => ({ value: true })));
  });

  test('different URLs are different questions', async () => {
    const net = fakeNetwork();
    const c = createFetchCoalescer({ fetcher: net.fetcher, identity: () => 'same' });
    void c.fetch('/api/terminal/sessions');
    void c.fetch('/api/terminal/sessions/dormant');
    expect(net.calls.length).toBe(2);
    net.answer('[]');
  });

  test('the same URL with a different method is a different key', async () => {
    const net = fakeNetwork();
    const c = createFetchCoalescer({ fetcher: net.fetcher, identity: () => 'same' });
    void c.fetch('/api/x');
    void c.fetch('/api/x', { method: 'DELETE' });
    expect(net.calls.length).toBe(2);
    net.answer('{}');
  });

  test('after the answer (no TTL) the next caller asks the network again', async () => {
    const net = fakeNetwork();
    const c = createFetchCoalescer({ fetcher: net.fetcher, identity: () => 'same' });
    const first = c.fetch('/api/system/status');
    net.answer('{"n":1}');
    expect((await (await first).json()).n).toBe(1);
    await flush();
    const second = c.fetch('/api/system/status');
    expect(net.calls.length).toBe(2);
    net.answer('{"n":2}');
    expect((await (await second).json()).n).toBe(2);
  });

  test('within the TTL the answer is reused; past it the network is asked again', async () => {
    const net = fakeNetwork();
    const t = clock();
    const c = createFetchCoalescer({ fetcher: net.fetcher, now: t.now, identity: () => 'same' });
    const first = c.fetch('/api/auth/orgs', undefined, { ttlMs: 2000 });
    net.answer('{"orgs":[1]}');
    await first;
    await flush();

    t.advance(700); // the WebSocket-open refetch, measured ~700 ms after the mount fetch
    const second = await c.fetch('/api/auth/orgs', undefined, { ttlMs: 2000 });
    expect(net.calls.length).toBe(1);
    expect(await second.json()).toEqual({ orgs: [1] });

    t.advance(2000);
    void c.fetch('/api/auth/orgs', undefined, { ttlMs: 2000 });
    expect(net.calls.length).toBe(2);
    net.answer('{"orgs":[2]}');
  });

  test('a network error is not remembered: the in-flight callers all fail, the next one retries', async () => {
    const net = fakeNetwork();
    const c = createFetchCoalescer({ fetcher: net.fetcher, identity: () => 'same' });
    const a = c.fetch('/api/browsers/engines', undefined, { ttlMs: 2000 });
    const b = c.fetch('/api/browsers/engines', undefined, { ttlMs: 2000 });
    expect(net.calls.length).toBe(1);
    // Both handlers are attached BEFORE the failure: a rejection nobody is
    // listening to yet is reported as unhandled by the runner. Plain `.then`
    // handlers and not `expect().rejects`: on bun 1.3.8 the latter, armed on a
    // promise that is still pending, never settled and the run spun at 100% CPU
    // (measured 2026-09-06 with this very test).
    const outcome = (p: Promise<Response>) => p.then(() => 'answered', (e: Error) => e.message);
    const failures = Promise.all([outcome(a), outcome(b)]);
    net.fail(new Error('offline'));
    expect(await failures).toEqual(['offline', 'offline']);
    void c.fetch('/api/browsers/engines', undefined, { ttlMs: 2000 });
    expect(net.calls.length).toBe(2);
    net.answer('{}');
  });

  test('a non-2xx answer is not remembered either, even with a TTL', async () => {
    const net = fakeNetwork();
    const c = createFetchCoalescer({ fetcher: net.fetcher, identity: () => 'same' });
    const first = c.fetch('/api/system/status', undefined, { ttlMs: 2000 });
    net.answer('{"error":"boom"}', 500);
    expect((await first).status).toBe(500);
    await flush();
    void c.fetch('/api/system/status', undefined, { ttlMs: 2000 });
    expect(net.calls.length).toBe(2);
    net.answer('{}');
  });

  test('a 204 comes back as a 204 with no body, to every caller', async () => {
    const net = fakeNetwork();
    const c = createFetchCoalescer({ fetcher: net.fetcher, identity: () => 'same' });
    const a = c.fetch('/api/projects/icon?path=x');
    const b = c.fetch('/api/projects/icon?path=x');
    net.answer('', 204);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(204);
    expect(rb.status).toBe(204);
    expect(await rb.text()).toBe('');
  });

  test('the init of the FIRST caller is what goes on the wire', async () => {
    const net = fakeNetwork();
    const c = createFetchCoalescer({ fetcher: net.fetcher, identity: () => 'same' });
    void c.fetch('/api/system/status', { priority: 'low' });
    void c.fetch('/api/system/status', { priority: 'high' });
    expect(net.calls.length).toBe(1);
    expect(net.calls[0].init?.priority).toBe('low');
    net.answer('{}');
  });

  test('an answer obtained through another `fetch` is not reused (the shell swaps fetch at boot, the tests per case)', async () => {
    const net = fakeNetwork();
    let who = 'stub-a';
    const c = createFetchCoalescer({ fetcher: net.fetcher, identity: () => who });
    const first = c.fetch('/api/system/status', undefined, { ttlMs: 2000 });
    net.answer('{"from":"a"}');
    await first;
    await flush();
    who = 'stub-b';
    void c.fetch('/api/system/status', undefined, { ttlMs: 2000 });
    expect(net.calls.length).toBe(2);
    net.answer('{"from":"b"}');
  });
});
