/**
 * After a DENIAL, "retry" must ask for a new code.
 *
 * The denied branch stops the loop (no timer is re-armed) and its button used
 * to call only `refreshSession()`. For a device that is still unpaired the
 * server answers the same `unpaired` state, `emit` drops it as unchanged, and
 * the effect, keyed on `[session.status, oraRiprova]`, never restarts: the
 * screen sat on «preparing» until a reload. Driven through the real component
 * with only the network faked.
 *
 * @covers PAIRING-03
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../../test/reactHarness';
import { PairingGate } from './PairingGate';
import { __resetSessionForTests, getSession, markUnpaired } from '../../lib/auth/session';

const realFetch = globalThis.fetch;
let harness: Harness | null = null;

afterEach(() => {
  harness?.unmount();
  harness = null;
  globalThis.fetch = realFetch;
  __resetSessionForTests();
});

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

describe('PairingGate · retry after a denial', () => {
  test('asks the server for a NEW code instead of waiting on a session that does not change', async () => {
    let requests = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/pair/request')) { requests++; return json({ requestId: `r${requests}`, code: 'ABC123', claim: 'c' }); }
      if (url.includes('/api/auth/pair/status')) return json({ state: 'denied' });
      if (url.includes('/api/auth/session')) return json({ paired: false, as: null, name: null });
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    __resetSessionForTests();
    markUnpaired(undefined);
    harness = mount(React.createElement(PairingGate, { session: getSession() }));
    await settle();
    expect(requests).toBe(1);

    // The denied card is the only one with a button now.
    const retry = harness.last().hosts.find((h) => h.type === 'button');
    expect(retry).toBeDefined();
    (retry!.props.onClick as () => void)();
    await settle();

    expect(requests).toBe(2);
  });
});
