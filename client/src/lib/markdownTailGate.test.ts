/**
 * The parse work of one streaming flush stays flat on a 20k-character reply,
 * whatever its shape. The work of a flush is the length of the text the markdown
 * parser reads: the tail block, as the gate lets it through.
 * @covers STREAMB-05
 */
import { describe, expect, test } from 'bun:test';
import { TAIL_PARSE_CAP, createTailGate, splitMarkdownBlocks } from './markdownBlocks';

const SHAPES: Record<string, string> = {
  prose: Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum dolor '.repeat(20)).join('\n\n'),
  fence: '```ts\n' + Array.from({ length: 900 }, (_, i) => `const v${i} = ${i}; // x`).join('\n') + '\n```\n',
  list: Array.from({ length: 500 }, (_, i) => `- item ${i} lorem ipsum dolor sit amet consectetur`).join('\n'),
  paragraph: 'word '.repeat(4000),
};
const TARGET = 20000;
const CHUNK = 80;

/** Characters the parser reads per flush: the drawn tail, when it changed since the last frame. */
function work(text: string, gated: boolean): number[] {
  const gate = createTailGate();
  const out: number[] = [];
  let drawn = '';
  for (let i = CHUNK; i <= Math.min(text.length, TARGET); i += CHUNK) {
    const blocks = splitMarkdownBlocks(text.slice(0, i));
    const tail = blocks[blocks.length - 1];
    const picked = gated ? gate.pick(tail, true) : tail;
    out.push(picked === drawn ? 0 : picked.length);
    drawn = picked;
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('streaming parse work per flush', () => {
  for (const [name, text] of Object.entries(SHAPES)) {
    test(`${name}: the late flushes cost what the early ones do`, () => {
      const w = work(text, true);
      const windowSize = 24;
      const early = mean(w.slice(Math.floor(w.length * 0.3), Math.floor(w.length * 0.3) + windowSize));
      const late = mean(w.slice(-windowSize));
      expect(late).toBeLessThan(TAIL_PARSE_CAP * 1.2);
      // Without the gate a fence, a list or a paragraph grows with its length.
      if (name !== 'prose') expect(mean(work(text, false).slice(-windowSize))).toBeGreaterThan(late * 1.5);
      expect(late / Math.max(early, 1)).toBeLessThan(2);
    });
  }

  test('a stream that ends draws the real text at once', () => {
    const gate = createTailGate();
    const long = 'word '.repeat(4000);
    gate.pick(long, true);
    const next = long + 'tail';
    expect(gate.pick(next, true)).toBe(long);
    expect(gate.pick(next, false)).toBe(next);
  });

  test('a tail that is not a continuation is parsed at once', () => {
    const gate = createTailGate();
    gate.pick('a '.repeat(5000), true);
    expect(gate.pick('b '.repeat(5000), true)).toBe('b '.repeat(5000));
  });
});
