/**
 * A chat message is drawn as markdown blocks, so that a token that arrives
 * parses the tail of the message and not all of it (STREAMB-04). These are the
 * rules that make that safe: where a cut may be made, where it never is, and
 * what the half-written tail is closed with.
 * @covers STREAMB-04
 */
import { describe, expect, test } from 'bun:test';
import { LONG_MESSAGE, paragraph } from '../test/longMarkdownMessage';
import { MIN_BLOCK_CHARS, completePartialMarkdown, openFenceStart, splitMarkdownBlocks } from './markdownBlocks';

describe('splitMarkdownBlocks', () => {
  test('a short message is one block, byte for byte', () => {
    const text = `${paragraph(1)}\n\n${paragraph(2)}\n`;
    expect(text.length).toBeLessThan(2 * MIN_BLOCK_CHARS);
    expect(splitMarkdownBlocks(text)).toEqual([text]);
    expect(splitMarkdownBlocks('')).toEqual(['']);
  });

  test('the blocks put back together are the message, whatever the line ends', () => {
    for (const text of [LONG_MESSAGE, LONG_MESSAGE.replace(/\n/g, '\r\n'), LONG_MESSAGE.trimEnd()]) {
      const blocks = splitMarkdownBlocks(text);
      expect(blocks.length).toBeGreaterThan(3);
      expect(blocks.join('')).toBe(text);
    }
  });

  test('a block is not cut off before it holds MIN_BLOCK_CHARS, and is cut in front of the next construct after', () => {
    const blocks = splitMarkdownBlocks(LONG_MESSAGE);
    for (const block of blocks.slice(0, -1)) {
      expect(block.length).toBeGreaterThanOrEqual(MIN_BLOCK_CHARS);
      expect(block.endsWith('\n\n')).toBe(true);
    }
    for (const block of blocks.slice(1)) expect(block[0]).not.toBe(' ');
  });

  test('a cut is never made inside a code fence, blank lines and all', () => {
    const body = `${'x = 1\n'.repeat(400)}\n# not a heading\n\n${'y = 2\n'.repeat(400)}`;
    const text = `${paragraph(1)}\n\n\`\`\`py\n${body}\`\`\`\n\n${paragraph(2)}\n\n${paragraph(3)}\n`;
    const blocks = splitMarkdownBlocks(text);
    expect(blocks.length).toBeGreaterThan(1);
    const withFence = blocks.filter((b) => b.includes('```py'));
    expect(withFence).toHaveLength(1);
    expect(withFence[0]).toContain(body);
  });

  test('a list is never cut, loose or numbered', () => {
    const item = (n: number) => `${n}. ${'an item that is long enough to matter, '.repeat(8)}\n\n`;
    const list = Array.from({ length: 12 }, (_, n) => item(n + 1)).join('');
    const text = `${paragraph(1)}\n\n${list}${paragraph(2)}\n\n${paragraph(3)}\n`;
    const blocks = splitMarkdownBlocks(text);
    const holding = blocks.filter((b) => b.includes('1. an item') || b.includes('12. an item'));
    expect(holding).toHaveLength(1);
    expect(holding[0]).toContain('1. an item');
    expect(holding[0]).toContain('12. an item');
  });

  test('the last line, which may still be growing, stays in the tail', () => {
    const text = `${LONG_MESSAGE}\n# A heading being typ`;
    const blocks = splitMarkdownBlocks(text);
    expect(blocks[blocks.length - 1]).toContain('# A heading being typ');
    expect(blocks.join('')).toBe(text);
  });

  test('markup that works on the whole document keeps the message in one block', () => {
    for (const extra of [
      '[ref]: https://example.com/ref "Title"',
      'A footnote.[^1]\n\n[^1]: the note',
      '$$\nx = y\n\nz = 1\n$$',
      '<!-- a comment\n\nthat has a blank line -->',
      '<pre>\nkept\n\nas is\n</pre>',
    ]) {
      expect(splitMarkdownBlocks(`${LONG_MESSAGE}\n${extra}\n`)).toHaveLength(1);
    }
  });

  test('the same markup inside a code fence does not stop the cut, if it is raw HTML', () => {
    const html = '```html\n<pre>\nkept\n\nas is\n</pre>\n<!-- c -->\n```';
    expect(splitMarkdownBlocks(`${LONG_MESSAGE}\n${html}\n`).length).toBeGreaterThan(3);
  });

  test('appending text never moves a cut already made', () => {
    // The tail grows and blocks are added after it, while the blocks in front keep
    // the very same strings: that is what lets each one be memoized.
    let before: string[] = [];
    for (let end = 0; end <= LONG_MESSAGE.length; end += 41) {
      const now = splitMarkdownBlocks(LONG_MESSAGE.slice(0, end));
      for (let i = 0; i < before.length - 1; i++) expect(now[i]).toBe(before[i]);
      expect(now.length).toBeGreaterThanOrEqual(before.length);
      before = now;
    }
  });

  test('a message that streams in as it is cut when it is whole', () => {
    expect(splitMarkdownBlocks(LONG_MESSAGE)).toEqual(splitMarkdownBlocks(`${LONG_MESSAGE.slice(0, 5000)}${LONG_MESSAGE.slice(5000)}`));
  });
});

describe('completePartialMarkdown', () => {
  test('closes the mark a half-typed token leaves open', () => {
    expect(completePartialMarkdown('a **bo')).toBe('a **bo**');
    expect(completePartialMarkdown('a *it')).toBe('a *it*');
    expect(completePartialMarkdown('call `foo')).toBe('call `foo`');
  });

  test('a link cut before its end shows as its text', () => {
    expect(completePartialMarkdown('see [the docs')).toBe('see the docs');
    expect(completePartialMarkdown('see [the docs](https://exa')).toBe('see [the docs]');
  });

  test('marks that are closed are left alone', () => {
    const text = 'a **bold** and `code` and *it*';
    expect(completePartialMarkdown(text)).toBe(text);
  });

  test('an open fence is left to markdown, and marks inside any fence are code', () => {
    expect(completePartialMarkdown('```ts\nconst a = "**"')).toBe('```ts\nconst a = "**"');
    expect(completePartialMarkdown('```ts\nconst a = "**"\n```\nthen **bo')).toBe('```ts\nconst a = "**"\n```\nthen **bo**');
    expect(completePartialMarkdown('```ts\nlet b = `x`\n```')).toBe('```ts\nlet b = `x`\n```');
  });
});

describe('openFenceStart', () => {
  test('is where the fence still open was opened, and null when every fence is closed', () => {
    expect(openFenceStart('prose\n\n```ts\nconst a')).toBe('prose\n\n'.length);
    expect(openFenceStart('```a\nx\n```\nprose\n~~~b\ny')).toBe('```a\nx\n```\nprose\n'.length);
    expect(openFenceStart('```a\nx\n```\nprose')).toBeNull();
    expect(openFenceStart('prose only')).toBeNull();
    expect(openFenceStart('')).toBeNull();
  });
});
