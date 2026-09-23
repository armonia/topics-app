/**
 * @covers TERM-WARM-01
 *
 * THE CLIENT HAS TO TELL "NOT YET" FROM "GONE".
 *
 * The server no longer spends a 404 on the seconds between accepting
 * connections and finishing its reconcile against the PTY bridge: those answer
 * 503 with `TERMINAL_ROSTER_WARMING_CODE` and a `Retry-After`. That only helps
 * if the client acts on the difference — a 503 read as a generic failure loses
 * the gesture exactly as the swallowed 404 did, and a 404 read as "not yet"
 * would retry forever against a session that really is gone.
 *
 * THE BAR, four-sided, because three of the sides are ways to get this subtly
 * wrong:
 *   1. the warming 503 is retried until it stops being one, and the caller sees
 *      only the final answer;
 *   2. a 404 is NOT retried — it is a verdict and goes straight back;
 *   3. the OTHER 503s these same routes answer (no PTY bridge in this build; a
 *      reload whose session would not stop) are not retried either, or one
 *      would become a hammer and the other a lie;
 *   4. the response handed back still has an UNREAD body, because the retry
 *      reads the envelope to recognise itself and the caller reads it again to
 *      build the sentence for the toast.
 */
import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { fetchWhileRosterWarms, SHORT_ROSTER_RETRIES } from './terminalRosterRetry';
import { STANDALONE_NO_PTY_CODE, TERMINAL_ROSTER_WARMING_CODE } from '../../../shared/terminal-messages';

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

/**
 * Every wait the retry asks for, in the order it asked. No test in this file
 * waits on a real clock: the recorder grants each wait at once, so a loaded
 * machine can neither turn these tests red nor need a wider window for them,
 * and the duration contract below is a sum of what the code ASKED FOR, which
 * no load factor can stretch.
 */
let asked: number[] = [];
beforeEach(() => {
  asked = [];
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    asked.push(ms ?? 0);
    return realSetTimeout(fn, 0, ...args);
  }) as unknown as typeof globalThis.setTimeout;
});
// Put back in `afterEach`, not at the end of a test body: an `expect` that
// throws first would otherwise leave the fake clock to every file after this
// one in the same shard.
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

function warming(): Response {
  return new Response(JSON.stringify({ error: 'still reconciling', code: TERMINAL_ROSTER_WARMING_CODE }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'Retry-After': '1' },
  });
}

/** Queue of canned answers; records how many times the network was asked. */
function stubFetch(answers: (() => Response)[]) {
  const calls: string[] = [];
  globalThis.fetch = ((input: string) => {
    calls.push(String(input));
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    return Promise.resolve(next());
  }) as typeof fetch;
  return calls;
}

describe('the warming 503 is waited out, everything else is passed through', () => {
  test('retries while the roster is warming and returns the answer that finally differs', async () => {
    const ok = () => new Response('{"ok":true}', { status: 200 });
    const calls = stubFetch([warming, warming, ok]);
    const res = await fetchWhileRosterWarms('/api/terminal/sessions/x/resize', { method: 'POST' });
    expect(res.status).toBe(200);
    // Three requests: two refused, one answered. The caller was told once.
    expect(calls.length).toBe(3);
  });

  test('a 404 is a verdict: returned on the first try, never retried', async () => {
    const calls = stubFetch([() => new Response('{"error":"Terminal session not found"}', { status: 404 })]);
    const res = await fetchWhileRosterWarms('/api/terminal/sessions/x/resize', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(calls.length).toBe(1);
  });

  test('the standalone 503 is NOT ours: no bridge exists in this build, retrying is a hammer', async () => {
    const calls = stubFetch([() => new Response(
      JSON.stringify({ error: 'terminals not available in standalone mode', code: STANDALONE_NO_PTY_CODE }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )]);
    const res = await fetchWhileRosterWarms('/api/terminal/sessions/x/reload', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(calls.length).toBe(1);
  });

  test('a 503 with no envelope at all is left alone: an unidentified 503 is not ours to retry', async () => {
    const calls = stubFetch([() => new Response('service unavailable', { status: 503 })]);
    const res = await fetchWhileRosterWarms('/api/terminal/sessions/x/reload', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(calls.length).toBe(1);
  });

  test('the body reaches the caller unread, so the toast can still read the code', async () => {
    stubFetch([() => new Response(
      JSON.stringify({ error: 'nope', code: STANDALONE_NO_PTY_CODE }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )]);
    const res = await fetchWhileRosterWarms('/api/terminal/sessions/x/reload', { method: 'POST' });
    // `bodyUsed` is the whole point of cloning inside the retry: this is what
    // `terminalErrorText` needs to say "not available in this installation"
    // instead of falling back to the generic sentence.
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toContain(STANDALONE_NO_PTY_CODE);
  });

  test('the budget is finite: a roster that never warms gives up and hands back the 503', async () => {
    const calls = stubFetch([warming]);
    const res = await fetchWhileRosterWarms('/api/terminal/sessions/x/reload', { method: 'POST' }, 2);
    expect(res.status).toBe(503);
    // First attempt + 2 retries. Without a cap this call would never return.
    expect(calls.length).toBe(3);
  });

  test('the short ladder fits inside the restart overlay net (15s), the long one would not', async () => {
    // 300 + 600 + 1200 + 2400 = 4500ms of waiting for SHORT_ROSTER_RETRIES=4.
    // Asserted as a duration because the constant alone does not say whether it
    // still fits after someone tunes the backoff shape. The duration is the sum
    // of the waits the retry asked for, not a wall clock: the overlay's 15s is a
    // constant in production (`terminalReload.ts`), so the bar here is the same
    // hand-written 15_000 on every machine, loaded or not.
    const calls = stubFetch([warming]);
    // The waits of THIS call only, through the injected clock: the global
    // recorder above also catches timers other files in the shard left behind.
    const own: number[] = [];
    await fetchWhileRosterWarms('/api/terminal/sessions/x/reload', { method: 'POST' }, SHORT_ROSTER_RETRIES, async (ms) => { own.push(ms); });
    expect(calls.length).toBe(SHORT_ROSTER_RETRIES + 1);
    // One wait between each pair of requests. Without this a fake clock that
    // intercepted nothing would sum to 0 and pass.
    expect(own.length).toBe(SHORT_ROSTER_RETRIES);
    const waited = own.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeLessThan(15_000);
  });
});
