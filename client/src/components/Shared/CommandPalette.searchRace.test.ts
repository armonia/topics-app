/**
 * AN OLDER MESSAGE SEARCH THAT ANSWERS LATE DOES NOT OVERWRITE A NEWER ONE.
 *
 * The debounce cleanup only cleared the timer, not a request already in
 * flight. Type "ab", wait for it to leave, type "abc": if the wider and slower
 * "ab" answered last, its results were drawn under the query "abc", and its
 * `finally` switched the spinner off while "abc" was still running. The same
 * defect `FileSearch` closed with `searchSeqRef`. Driven through the real
 * palette; only the network and the browser globals are faked.
 *
 * @covers PALETTE-01
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { mount, type Harness } from '../../test/reactHarness';
import { CommandPalette } from './CommandPalette';

const realFetch = globalThis.fetch;
const g = globalThis as unknown as Record<string, unknown>;
const BROWSER_KEYS = ['window', 'document', 'getComputedStyle'] as const;
const saved: Record<string, unknown> = {};
let harness: Harness | null = null;

beforeEach(() => {
  for (const k of BROWSER_KEYS) saved[k] = g[k];
  g.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800, dispatchEvent: () => true, setTimeout };
  g.document = {
    activeElement: null, body: {}, addEventListener() {}, removeEventListener() {},
    documentElement: { classList: { contains: () => false } },
  };
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
});
afterEach(() => {
  harness?.unmount(); harness = null; globalThis.fetch = realFetch;
  for (const k of BROWSER_KEYS) { if (saved[k] === undefined) delete g[k]; else g[k] = saved[k]; }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hit = (content: string) => ({
  results: [{ topicId: 't1', topicName: 'Topic', sessionKey: 's', role: 'user', content, timestamp: 1 }],
});

describe('CommandPalette · message search race', () => {
  test('the late answer for "ab" does not replace the results of "abc"', async () => {
    const pending = new Map<string, (r: Response) => void>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/search')) {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        return new Promise<Response>((resolve) => { pending.set(query, resolve); });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const noop = () => {};
    harness = mount(React.createElement(CommandPalette, {
      isOpen: true, onClose: noop, topics: [], onOpenTopic: noop, onOpenProject: noop,
      onNewTopic: noop, onProjectPicker: noop, onAddPane: noop, onToggleTheme: noop,
      onOpenSettings: noop, themeMode: 'dark',
    } as unknown as React.ComponentProps<typeof CommandPalette>));
    const type = (value: string) => {
      const input = harness!.last().hosts.find((h) => h.type === 'input' && h.props.type === 'text')!;
      (input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
    };

    type('ab');
    await wait(350);
    type('abc');
    await wait(350);
    expect([...pending.keys()]).toEqual(['ab', 'abc']);

    pending.get('abc')!(new Response(JSON.stringify(hit('NEWER abc result'))));
    await wait(10);
    pending.get('ab')!(new Response(JSON.stringify(hit('OLDER ab result'))));
    await wait(10);

    const text = harness.last().text;
    expect(text).toContain('NEWER abc result');
    expect(text).not.toContain('OLDER ab result');
  });
});
