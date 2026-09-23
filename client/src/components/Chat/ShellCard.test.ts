/**
 * A LONG COMMAND DOES NOT PUSH ITS OUTPUT OFF SCREEN.
 *
 * The command block of ShellCard had no height cap: a 300-line heredoc filled
 * the whole viewport and the output (the thing you opened the row to read)
 * sat below the fold. Same cap as the Monitor command (max-h-40) with its own
 * scroll. The output keeps its own, larger cap.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo).
 *
 * @covers CHAT-TOOL-04
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShellCard } from './ToolCards';

/** The class attribute of the element carrying `data-testid="<id>"`. */
function classOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at).toBeGreaterThan(-1);
  const tagStart = html.lastIndexOf('<', at);
  const tagEnd = html.indexOf('>', at);
  const tag = html.slice(tagStart, tagEnd);
  return /class="([^"]*)"/.exec(tag)?.[1] ?? '';
}

describe('ShellCard command block', () => {
  test('is capped at max-h-40 and scrolls on its own', () => {
    const command = Array.from({ length: 300 }, (_, i) => `echo line ${i}`).join('\n');
    const html = renderToStaticMarkup(createElement(ShellCard, { command, output: 'ok' }));
    const cls = classOf(html, 'tool-call-args').split(/\s+/);
    expect(cls).toContain('max-h-40');
    expect(cls).toContain('overflow-auto');
  });

  test('the output keeps its own cap', () => {
    const html = renderToStaticMarkup(createElement(ShellCard, { command: 'ls', output: 'a\nb' }));
    expect(classOf(html, 'tool-call-result').split(/\s+/)).toContain('max-h-72');
  });
});
