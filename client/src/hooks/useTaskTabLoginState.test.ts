/**
 * A FAILED APPLY IS RETRIED EVEN WHEN THE TAB WENT AWAY FIRST.
 *
 * The context is marked «served» before the request, and the mark is rolled
 * back when the reply is not an answer (network down, 5xx). The rollback sat
 * behind `if (!alive) return`: close the drawer before the failure arrives and
 * the mark stayed, so no later mount retried for the whole app session and the
 * reviewer had to log in by hand. Driven through the real hook.
 *
 * @covers LOGINST-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../test/reactHarness';
import { useTaskTabLoginState } from './useTaskTabLoginState';

const realFetch = globalThis.fetch;
let harness: Harness | null = null;
afterEach(() => { harness?.unmount(); harness = null; globalThis.fetch = realFetch; });

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

function Probe({ contextId }: { contextId: string }): null {
  useTaskTabLoginState(contextId, true);
  return null;
}

describe('useTaskTabLoginState · retry after a failure', () => {
  test('unmounted before a 5xx: the next mount asks again', async () => {
    const id = `task-${crypto.randomUUID()}`;
    let calls = 0;
    const held: { fail?: () => void } = {};
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        // Held until the drawer is closed.
        return new Promise<Response>((resolve) => { held.fail = () => resolve(new Response('', { status: 502 })); });
      }
      return new Response(JSON.stringify({ applied: true, handle: 'h' }), { status: 200 });
    }) as unknown as typeof fetch;

    harness = mount(React.createElement(Probe, { contextId: id }));
    await settle();
    harness.unmount();
    harness = null;
    held.fail!();
    await settle();

    harness = mount(React.createElement(Probe, { contextId: id }));
    await settle();
    expect(calls).toBe(2);
  });

  test('an answer is kept: a second mount does not ask again', async () => {
    const id = `task-${crypto.randomUUID()}`;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ applied: false, handle: null })); }) as unknown as typeof fetch;
    harness = mount(React.createElement(Probe, { contextId: id }));
    await settle();
    harness.unmount();
    harness = mount(React.createElement(Probe, { contextId: id }));
    await settle();
    expect(calls).toBe(1);
  });
});
