/**
 * The single door every copy action goes through, and every way the browser
 * can refuse it without throwing.
 *
 * @covers CHAT-03
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { copyText } from './clipboard';

type StubNavigator = { clipboard?: { writeText?: (t: string) => Promise<void> } };
const g = globalThis as unknown as { navigator: StubNavigator | undefined };
const realNavigator = g.navigator;

afterEach(() => { g.navigator = realNavigator; });

describe('copyText — l’unica porta per «copia»', () => {
  test('copia e dice di sì', async () => {
    const written: string[] = [];
    g.navigator = { clipboard: { writeText: async (t) => { written.push(t); } } };
    expect(await copyText('ciao')).toBe(true);
    expect(written).toEqual(['ciao']);
  });

  test('fuori da un secure context `clipboard` è undefined: `false`, non un’eccezione', async () => {
    // È il caso che rompe i call-site scritti senza `?.`: l’accesso alla
    // proprietà TIRA e si porta via tutto l’handler del click.
    g.navigator = {};
    expect(await copyText('ciao')).toBe(false);
  });

  test('senza navigator del tutto (test, SSR) resta `false`', async () => {
    g.navigator = undefined;
    expect(await copyText('ciao')).toBe(false);
  });

  test('permesso negato / documento non a fuoco: `false`, mai una promise rifiutata', async () => {
    g.navigator = { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } };
    expect(await copyText('ciao')).toBe(false);
  });

  test('una writeText SINCRONAMENTE esplosiva è comunque catturata', async () => {
    g.navigator = { clipboard: { writeText: (() => { throw new Error('boom'); }) as () => Promise<void> } };
    expect(await copyText('ciao')).toBe(false);
  });
});
