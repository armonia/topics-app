/**
 * The shared find highlights: a one-letter query on a long page hands this
 * module hundreds of thousands of ranges, and spreading them into the
 * `Highlight` constructor overflows the engine's argument limit (V8 near
 * 100k, JavaScriptCore here near 1M). The counter then said 0.
 *
 * @covers FIND-01
 */
import { describe, expect, test } from 'bun:test';
import { clearFindHighlights, setFindHighlights } from './findHighlights';

class FakeHighlight {
  readonly ranges = new Set<unknown>();
  constructor(...r: unknown[]) { for (const x of r) this.ranges.add(x); }
  add(r: unknown) { this.ranges.add(r); return this; }
}

function fakeDoc() {
  const registry = new Map<string, FakeHighlight>();
  const doc = { defaultView: { CSS: { highlights: registry }, Highlight: FakeHighlight } } as unknown as Document;
  return { doc, registry };
}

describe('setFindHighlights', () => {
  test('a million matches are painted, not thrown', () => {
    const { doc, registry } = fakeDoc();
    const hits = Array.from({ length: 1_000_000 }, () => ({}) as Range);
    expect(() => setFindHighlights('big', doc, hits, hits[0]!)).not.toThrow();
    expect(registry.get('find-hit')?.ranges.size).toBe(999_999);
    expect(registry.get('find-current')?.ranges.size).toBe(1);
    clearFindHighlights('big');
    expect(registry.has('find-hit')).toBe(false);
  });
});
