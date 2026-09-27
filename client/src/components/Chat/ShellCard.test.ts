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
 * While the command runs, its partial output shows as the running tail
 * (CHAT-TOOL-08) in place of the output block, which is the final one's.
 *
 * @covers CHAT-TOOL-04, CHAT-TOOL-08
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

describe('ShellCard while the command runs', () => {
  const partial = Array.from({ length: 20 }, (_, i) => `r${i + 1}`).join('\n');

  test('the running tail stands in for the output, with the notice above it', () => {
    // The window you sent from: the derived detail carries the partial as its
    // output too, and it must not show twice.
    const html = renderToStaticMarkup(createElement(ShellCard, { command: 'bun test', output: partial, liveResult: partial }));
    expect(html).toContain('data-testid="shell-running-tail"');
    expect(html).not.toContain('data-testid="tool-call-result"');
    expect(html).toContain('r13');
    expect(html).not.toContain('r12<');
    expect(html).toContain('Sopra c&#x27;è altro output');
  });

  test('without a partial the card is the one of before', () => {
    const html = renderToStaticMarkup(createElement(ShellCard, { command: 'bun test', output: 'ok' }));
    expect(html).not.toContain('shell-running-tail');
    expect(html).toContain('data-testid="tool-call-result"');
  });
});
