/**
 * @covers TERM-SAY-01
 *
 * THE TOAST WITH THE BRACES IN IT.
 *
 * The «Ricarica» gesture was cured once already: it checks `res.ok` and drops   allow-italian: quoted UI string
 * the restart overlay on a refusal. What it then showed was the response
 * body RAW — and `errorResponse` on the server always serialises
 * `{"error": "..."}`. So the cure delivered, literally,
 * `{"error":"Reload already in progress for this session"}`: braces, English,
 * and on a 500 the internal exception message of a spawn that failed.
 *
 * This file asserts the shape of what reaches the toast, not the wording: no
 * leading brace, nothing of the server's own sentence, and the overlay gone.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

const g = globalThis as unknown as { window?: unknown; fetch: typeof fetch };
let savedWindow: unknown;
let savedFetch: typeof fetch;

beforeEach(() => {
  savedWindow = g.window;
  savedFetch = g.fetch;
  // `restartTerminalSession` arms its 15s safety net through `window`: the
  // module runs in a browser and there is no DOM in this runner, so the two
  // timer functions are all it needs from one.
  g.window = { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis) };
});

afterEach(() => {
  g.window = savedWindow;
  g.fetch = savedFetch;
});

const settle = () => new Promise((r) => setTimeout(r, 0));

function fakeToast() {
  const messages: string[] = [];
  return { messages, error: (m: string) => { messages.push(m); } };
}

/** Identity translator: the test reads the KEY, so it never asserts a wording. */
const trKey = (key: string) => key;

describe('restartTerminalSession', () => {
  test('a 409 does not arrive on screen as JSON', async () => {
    g.fetch = (async () => new Response(
      JSON.stringify({ error: 'Reload already in progress for this session' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const { restartTerminalSession } = await import('./terminalReload');
    const toast = fakeToast();

    restartTerminalSession('sess-1', toast, trKey);
    await settle();

    expect(toast.messages).toHaveLength(1);
    // THE BAR: not a single brace, and not one word of the server's English.
    expect(toast.messages[0].startsWith('{')).toBe(false);
    expect(toast.messages[0]).not.toContain('Reload already in progress');
    expect(toast.messages[0]).toBe('terminal.err.busy');

    const { useSignalsStore } = await import('../state/signals');
    expect(useSignalsStore.getState().terminalReloadingIds.has('sess-1')).toBe(false);
  });

  test('a 500 says the gesture failed, not what threw inside the server', async () => {
    g.fetch = (async () => new Response(
      JSON.stringify({ error: 'Failed to reload session: spawn /usr/local/bin/claude ENOENT' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const { restartTerminalSession } = await import('./terminalReload');
    const toast = fakeToast();

    restartTerminalSession('sess-2', toast, trKey);
    await settle();

    expect(toast.messages).toEqual(['tab.restartSessionFailed']);
  });

  test('a network that never answers keeps its own sentence', async () => {
    g.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const { restartTerminalSession } = await import('./terminalReload');
    const toast = fakeToast();

    restartTerminalSession('sess-3', toast, trKey);
    await settle();

    expect(toast.messages).toEqual(['tab.restartSessionUnreachable']);
  });
});
