/**
 * A FAILED incognito toggle must say so.
 *
 * The entry closes the menu on click, and the PATCH rejection was swallowed
 * (`.catch(() => {})`): on a network blip or a 5xx the project stayed visible
 * to the group while the person believed it hidden. Driven through the real
 * entry inside the real toast provider; only the network is faked.
 *
 * @covers PROJECT-INCOGNITO-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mount, type Harness } from '../../test/reactHarness';
import { ToastProvider } from '../Shared/Toast';
import { EntryIncognito } from './EntryIncognito';

const realFetch = globalThis.fetch;
let harness: Harness | null = null;
afterEach(() => { harness?.unmount(); harness = null; globalThis.fetch = realFetch; });

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

function drive(patchStatus: number) {
  let done = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return new Response(JSON.stringify(patchStatus === 200 ? { id: 'p1', incognito: true } : { error: 'boom' }), {
        status: patchStatus, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ id: 'p1', path: '/x', incognito: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  harness = mount(createElement(ToastProvider, {
    children: createElement(EntryIncognito, { projectPath: '/x', onDone: () => { done++; } }),
  }));
  const toasts = () => (harness!.last().providerValues[1] as { toasts: { type: string }[] }).toasts;
  const click = () => {
    const button = harness!.last().hosts.find((h) => h.type === 'button');
    (button!.props.onClick as () => void)();
  };
  return { toasts, click, done: () => done };
}

describe('EntryIncognito · the outcome of the toggle', () => {
  test('a rejected PATCH raises an error toast', async () => {
    const d = drive(500);
    await settle();
    d.click();
    await settle();
    expect(d.done()).toBe(1);
    expect(d.toasts().map((x) => x.type)).toEqual(['error']);
  });

  test('a PATCH that succeeds stays silent', async () => {
    const d = drive(200);
    await settle();
    d.click();
    await settle();
    expect(d.toasts()).toEqual([]);
  });
});
