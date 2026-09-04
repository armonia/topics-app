/**
 * @covers TERM-SAY-01
 *
 * WHAT A REFUSAL LOOKS LIKE ON SCREEN.
 *
 * Two opposite failures met on this surface. Creating a terminal and renaming a
 * tab threw the server's answer away entirely (`if (!res.ok) return;`,
 * `.catch(() => {})`), so a refused «+ → Claude Code» did nothing at all and a
 * refused rename put the old label back without a word.        allow-italian: quoted UI string
 * Restarting did the opposite: it took `await res.text()` and handed it to the
 * toast, and since `errorResponse` always serialises `{"error": "..."}` what a
 * person read was a pair of braces around an English internal sentence.
 *
 * So the assertions here are about the SENTENCE: it comes from the catalogue,
 * it never starts with a brace, and the two different 503s of these routes
 * (no bridge in this build vs. a session that would not stop in time) do not
 * end up saying the same thing.
 */
import { describe, expect, test } from 'bun:test';
import {
  terminalErrorText,
  terminalUnreachableText,
  createTerminalSession,
  renameTerminalSession,
} from './terminalActions';
import { STANDALONE_NO_PTY_CODE } from '../../../shared/terminal-messages';
import en from './i18n-en';

/** The real English catalogue: a key that does not exist would return itself. */
const tr = (key: string): string => {
  const value = (en as Record<string, string>)[key];
  if (!value) throw new Error(`chiave i18n mancante: ${key}`);
  return value;
};

function fakeToast() {
  const messages: string[] = [];
  return { messages, error: (m: string) => { messages.push(m); } };
}

/** One tick of the microtask queue, enough for a resolved fetch chain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('terminalErrorText', () => {
  test('the envelope never reaches the screen: no braces, no server English', () => {
    const body = JSON.stringify({ error: 'Reload already in progress for this session' });
    const said = terminalErrorText('restart', 409, body, tr);
    expect(said.startsWith('{')).toBe(false);
    expect(said).not.toContain('Reload already in progress');
    expect(said).toBe(en['terminal.err.busy']);
  });

  test('a 500 does not leak the internal exception message', () => {
    const body = JSON.stringify({ error: 'Failed to reload session: ENOENT /usr/local/bin/claude' });
    const said = terminalErrorText('restart', 500, body, tr);
    expect(said).not.toContain('ENOENT');
    expect(said).toBe(en['tab.restartSessionFailed']);
  });

  test('the two 503s of these routes are not the same sentence', () => {
    const standalone = terminalErrorText(
      'create', 503,
      JSON.stringify({ error: 'terminals not available in standalone mode', code: STANDALONE_NO_PTY_CODE }),
      tr,
    );
    const wontStop = terminalErrorText(
      'restart', 503,
      JSON.stringify({ error: 'Session did not stop in time. Please retry.' }),
      tr,
    );
    expect(standalone).toBe(en['terminal.err.unavailable']);
    expect(wontStop).toBe(en['terminal.err.retry']);
    expect(standalone).not.toBe(wontStop);
  });

  test('a body that is not the envelope still gets a sentence', () => {
    expect(terminalErrorText('rename', 404, '<html>502 Bad Gateway</html>', tr))
      .toBe(en['terminal.err.notFound']);
    expect(terminalErrorText('create', 502, '', tr)).toBe(en['terminal.err.createFailed']);
    expect(terminalErrorText('create', 400, '', tr)).toBe(en['terminal.err.createFailed']);
    expect(terminalErrorText('create', 401, '', tr)).toBe(en['terminal.err.unauthorized']);
  });

  test('each gesture has its own words for "no answer at all"', () => {
    expect(terminalUnreachableText('create', tr)).toBe(en['terminal.err.createUnreachable']);
    expect(terminalUnreachableText('rename', tr)).toBe(en['terminal.err.renameUnreachable']);
    expect(terminalUnreachableText('restart', tr)).toBe(en['tab.restartSessionUnreachable']);
  });
});

describe('createTerminalSession', () => {
  const original = globalThis.fetch;

  test('a 503 with no bridge: null AND a sentence that names the terminal', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'terminals not available in standalone mode', code: STANDALONE_NO_PTY_CODE }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const toast = fakeToast();
    try {
      const created = await createTerminalSession({ type: 'shell' }, toast, tr);
      expect(created).toBeNull();
      expect(toast.messages).toEqual([en['terminal.err.unavailable']]);
      expect(toast.messages[0]).toMatch(/terminal/i);
    } finally { globalThis.fetch = original; }
  });

  test('a network that never answers is not silence either', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const toast = fakeToast();
    try {
      expect(await createTerminalSession({ type: 'shell' }, toast, tr)).toBeNull();
      expect(toast.messages).toEqual([en['terminal.err.createUnreachable']]);
    } finally { globalThis.fetch = original; }
  });

  test('on success it says nothing and hands back the session', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ id: 'abc', name: 'Shell', cwd: '/tmp', command: '/bin/sh', createdAt: 'now', type: 'shell' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const toast = fakeToast();
    try {
      const created = await createTerminalSession({ type: 'shell' }, toast, tr);
      expect(created?.id).toBe('abc');
      expect(toast.messages).toEqual([]);
    } finally { globalThis.fetch = original; }
  });
});

describe('renameTerminalSession', () => {
  const original = globalThis.fetch;

  test('a 404 is spoken: the tab relabels off the roster, so nothing else would show it', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'Terminal session not found' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const toast = fakeToast();
    try {
      renameTerminalSession('gone', 'nuovo nome', toast, tr);
      await settle();
      expect(toast.messages).toEqual([en['terminal.err.notFound']]);
    } finally { globalThis.fetch = original; }
  });

  test('a rename that lands says nothing', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const toast = fakeToast();
    try {
      renameTerminalSession('live', 'nuovo nome', toast, tr);
      await settle();
      expect(toast.messages).toEqual([]);
    } finally { globalThis.fetch = original; }
  });
});
