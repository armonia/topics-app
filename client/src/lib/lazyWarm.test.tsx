/**
 * A warm chunk renders without a boundary; a cold one still goes through
 * `React.lazy` and shows the fallback of the boundary around it.
 *
 * @covers PERF-02
 */
import { describe, expect, test } from 'bun:test';
import { Suspense } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { lazyWarm, warm, warmed } from './lazyWarm';

function Body({ label }: { label: string }) {
  return <section data-testid="body">{label}</section>;
}

describe('lazyWarm', () => {
  test('a chunk seen by `warm` renders in the same pass, with no fallback', async () => {
    const load = () => Promise.resolve({ Body });
    await warm(load);
    expect(warmed(load)).toBeDefined();
    const Warmed = lazyWarm(load, (m) => m.Body);
    const html = renderToStaticMarkup(<Suspense fallback={<i>spinner</i>}><Warmed label="hello" /></Suspense>);
    expect(html).toContain('hello');
    expect(html).not.toContain('spinner');
  });

  test('a cold chunk falls back to React.lazy and the boundary shows its fallback', () => {
    const load = () => new Promise<{ Body: typeof Body }>(() => {});
    expect(warmed(load)).toBeUndefined();
    const Cold = lazyWarm(load, (m) => m.Body);
    const html = renderToStaticMarkup(<Suspense fallback={<i>spinner</i>}><Cold label="hello" /></Suspense>);
    expect(html).toContain('spinner');
    expect(html).not.toContain('hello');
  });

  test('warm remembers by loader identity, not by module', async () => {
    const module = { Body };
    const a = () => Promise.resolve(module);
    const b = () => Promise.resolve(module);
    await warm(a);
    expect(warmed(a)).toBe(module);
    expect(warmed(b)).toBeUndefined();
  });
});
