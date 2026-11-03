/**
 * The entrance of live text fades pieces in without holding any of them back:
 * the rendered text always holds everything that arrived, every logged piece is
 * its own span in order, only the pieces younger than STREAM_FADE_MS animate,
 * and text present at mount never fades (card cd66c3bd).
 * @covers CHAT-LIVE-TEXT-02
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatMarkdown } from '../components/ChatMarkdown';
import { STREAM_FADE_MS, createArrivalLog, fadeSegments, rehypeStreamFade, type Arrival } from './streamFade';

const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
const md = (source: string, arrivals: Arrival[], t: number) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: [[rehypeStreamFade, { base: 0, arrivals, t }]] }, source));

describe('arrival log', () => {
  test('text present at mount is not new; each append is logged with its own arrival time', () => {
    const log = createArrivalLog(10);
    expect(log.update(10, true, 0)).toEqual([]);
    expect(log.update(14, true, 100)).toEqual([{ from: 10, to: 14, at: 100 }]);
    expect(log.update(20, true, 160)).toEqual([
      { from: 10, to: 14, at: 100 },
      { from: 14, to: 20, at: 160 },
    ]);
  });

  test('a finished turn or a rewritten text logs nothing', () => {
    const log = createArrivalLog(0);
    log.update(5, true, 0);
    expect(log.update(5, false, 10)).toEqual([]);
    const again = createArrivalLog(0);
    again.update(8, true, 0);
    expect(again.update(3, true, 10)).toEqual([]);
  });
});

describe('fade segments', () => {
  test('segments always join back into the text, and only young pieces are fresh', () => {
    const value = 'hello brave new world';
    const arrivals = [{ from: 6, to: 11, at: 0 }, { from: 15, to: 99, at: 100 }];
    const segs = fadeSegments(value, 0, arrivals, 100 + STREAM_FADE_MS - 1);
    expect(segs.map((s) => s.text).join('')).toBe(value);
    expect(segs.filter((s) => s.piece).map((s) => [s.text, s.fresh])).toEqual([['brave', false], [' world', true]]);
    expect(fadeSegments(value, 100, arrivals)).toEqual([{ text: value, piece: false }]);
  });
});

describe('rehype plugin in markdown', () => {
  test('every piece is a span in order; only the young one animates; all text is there', () => {
    const source = 'Hello **bold** world and more';
    const html = md(source, [{ from: 14, to: 20, at: 0 }, { from: 20, to: source.length, at: 500 }], 520);
    expect(textOf(html)).toBe('Hello bold world and more');
    expect(html).toContain('<span> world</span><span class="stream-fade"> and more</span>');
    expect(html.match(/stream-fade/g)?.length).toBe(1);
  });

  test('a text node is placed by its end, so an entity before the new piece does not shift it', () => {
    const source = 'Tom &amp; Jerry went home now';
    const html = md(source, [{ from: source.length - 4, to: source.length, at: 0 }], 10);
    expect(html).toContain('<span class="stream-fade"> now</span>');
    expect(textOf(html)).toBe('Tom & Jerry went home now');
  });

  test('code and text with a mention are left as plain strings', () => {
    const code = 'Run `ls -la` now';
    const html = md(code, [{ from: 0, to: code.length, at: 0 }], 0);
    expect(html).toContain('<code>ls -la</code>');
    expect(textOf(html)).toBe('Run ls -la now');
    expect(md('ping @attilio please', [{ from: 0, to: 20, at: 0 }], 0)).not.toContain('<span');
  });

  test('a streaming message that mounts with its text (history, remount) does not fade', () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { components: {}, streaming: true, children: 'Already here.' }));
    expect(html).not.toContain('<span');
    expect(textOf(html)).toBe('Already here.');
  });
});

describe('css', () => {
  test('opacity only, off under prefers-reduced-motion and in a window without focus', () => {
    const css = readFileSync(join(import.meta.dir, '../index.css'), 'utf8');
    const keyframes = css.match(/@keyframes streamFadeIn \{[^}]*\{[^}]*\}[^}]*\{[^}]*\}\s*\}/)?.[0] ?? '';
    expect(keyframes).toContain('opacity');
    expect(keyframes).not.toContain('transform');
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.stream-fade \{\s*animation: none;/);
    expect(css).toMatch(/\.anims-paused \.stream-fade \{\s*animation: none !important;/);
  });
});
