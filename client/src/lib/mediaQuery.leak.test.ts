/**
 * COUNTER BENCH: the `MediaQueryList` allocations of a mount cycle.
 *
 * `window.matchMedia(q)` is not a read, it is an allocation: the returned
 * `MediaQueryList` is registered with the document's media query matcher, which
 * holds on to it. Six call sites in this client called it inline, so a screen
 * that only re-rendered kept minting lists nobody read again. That is how a
 * previous measurement on this app watched live `MediaQueryList` objects go
 * from 379 to 1120 in 104 minutes with nobody touching the machine.
 *
 * `lib/mediaQuery.ts` makes it one list per query for the whole session. This
 * file does not read that memo, it counts: `window.matchMedia` is replaced with
 * a counting fake, the real hook is mounted and unmounted N times, and what is
 * asserted is the SLOPE. A memo means the count stops growing with the cycles;
 * without it the count is a multiple of N, and this bench goes red.
 *
 * @covers LEAK-05
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { mediaQueryMatches, resetMediaQueryCache } from './mediaQuery';

const CYCLES = 20;

const g = globalThis as unknown as { window?: unknown };
let allocations = 0;
let liveLists = 0;
let savedWindow: unknown;

/** A `MediaQueryList` that only knows how to be counted. */
function fakeList(query: string) {
  allocations++;
  liveLists++;
  return {
    media: query,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    // No removal API on the real thing either: a list is released only when
    // nothing references it, which is exactly why minting them per render is
    // the whole defect.
    addListener: () => {},
    removeListener: () => {},
  } as unknown as MediaQueryList;
}

beforeEach(() => {
  allocations = 0;
  liveLists = 0;
  savedWindow = g.window;
  g.window = { matchMedia: (q: string) => fakeList(q) };
  resetMediaQueryCache();
});

afterEach(() => {
  g.window = savedWindow;
  resetMediaQueryCache();
});

function report(name: string, before: number, after: number, cycles: number): void {
  console.log(
    `LEAK-COUNTER matchmedia | ${name} | before=${before} after=${after} cycles=${cycles} | ` +
    `${before === after ? 'ok' : 'LEAK'}`,
  );
}

function Probe({ query }: { query: string }): React.ReactElement | null {
  useMediaQuery(query);
  return null;
}

describe('MediaQueryList allocations', () => {
  test('N mount/unmount cycles of useMediaQuery allocate ONE list, not N', () => {
    // First cycle: the list for this query is minted here, legitimately.
    const warm = mount(React.createElement(Probe, { query: '(min-width: 768px)' }));
    warm.unmount();
    const before = allocations;

    for (let i = 0; i < CYCLES; i++) {
      const h = mount(React.createElement(Probe, { query: '(min-width: 768px)' }));
      h.rerender();
      h.unmount();
    }
    const after = allocations;

    report('lists allocated (useMediaQuery)', before, after, CYCLES);
    expect(before).toBe(1);
    expect(after).toBe(before);
  });

  test('a repeated read allocates nothing after the first', () => {
    mediaQueryMatches('(hover: hover)');
    const before = allocations;
    for (let i = 0; i < CYCLES; i++) mediaQueryMatches('(hover: hover)');
    const after = allocations;
    report('lists allocated (repeated read)', before, after, CYCLES);
    expect(after).toBe(before);
  });

  test('a DIFFERENT query still gets its own list, so the memo is not a mute', () => {
    mediaQueryMatches('(hover: hover)');
    mediaQueryMatches('(display-mode: standalone)');
    mediaQueryMatches('(prefers-color-scheme: dark)');
    expect(allocations).toBe(3);
    expect(liveLists).toBe(3);
  });

  test('the counter can fail: an inline matchMedia grows with the cycles', () => {
    // The control. This is the shape the six call sites had, run through the
    // same fake: if the bench above passed with the memo removed, this one
    // would pass too, and neither would mean anything.
    const w = g.window as { matchMedia: (q: string) => MediaQueryList };
    const before = allocations;
    for (let i = 0; i < CYCLES; i++) w.matchMedia('(min-width: 768px)');
    expect(allocations - before).toBe(CYCLES);
  });
});
