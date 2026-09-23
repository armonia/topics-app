/**
 * A FAILURE INSIDE A CLOSED GROUP IS ONE CLICK AWAY.
 *
 * The closed group showed its failure count and nothing else: the badge was plain
 * text inside the toggle, so reaching the failed row meant opening the group
 * and hunting for it among N rows. Now the badge is its own button: it names
 * the first error in its title, and a click opens the group on that row.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo): the click itself
 * is covered by the E2E grouping spec; here the markup and the pure picker.
 *
 * @covers CHAT-TOOL-02
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolCall } from '../../types';
import { GroupedToolRows } from './ToolGroupRow';
import { firstFailedTool } from './toolGrouping';

const ok = (id: string): ToolCall => ({ id, name: 'Read', args: { file_path: `/r/${id}.ts` }, status: 'success' });
const failed = (id: string, error: string): ToolCall => ({ id, name: 'Bash', args: { command: 'bun test' }, status: 'error', error });

describe('firstFailedTool', () => {
  test('picks the first failed call and the first non-empty line of its error', () => {
    const got = firstFailedTool([ok('a'), failed('b', '\n  exit 1: 3 tests failed\nstack…'), failed('c', 'later')]);
    expect(got).toEqual({ id: 'b', firstLine: 'exit 1: 3 tests failed' });
  });

  test('falls back to the result text when the call has no error field', () => {
    const tc: ToolCall = { id: 'x', name: 'Bash', args: {}, status: 'error', result: 'command not found: foo' };
    expect(firstFailedTool([tc])).toEqual({ id: 'x', firstLine: 'command not found: foo' });
  });

  test('none failed: nothing to point at', () => {
    expect(firstFailedTool([ok('a'), ok('b')])).toBeNull();
  });
});

describe('the failure badge of a closed group', () => {
  const html = renderToStaticMarkup(
    createElement(GroupedToolRows, { tools: [ok('a'), ok('b'), failed('c', 'exit 1: 3 tests failed\nmore'), ok('d')] }),
  );

  /** The opening tag of the element carrying `data-testid="<id>"`. */
  function tagOf(testId: string): string {
    const at = html.indexOf(`data-testid="${testId}"`);
    expect(at).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  }

  test('is a button, and its title names the first error', () => {
    const tag = tagOf('tool-group-errors');
    expect(tag.startsWith('<button')).toBe(true);
    expect(tag).toContain('title="exit 1: 3 tests failed"');
  });

  test('is not nested inside another button', () => {
    const at = html.indexOf('data-testid="tool-group-errors"');
    const before = html.slice(0, at);
    const opened = (before.match(/<button/g) ?? []).length;
    const closed = (before.match(/<\/button>/g) ?? []).length;
    // The badge's own `<button` is counted in `before`: exactly one open.
    expect(opened - closed).toBe(1);
  });

  test('the summary still carries the whole row text and a toggle', () => {
    expect(tagOf('tool-group-summary')).not.toContain('<button');
    expect(tagOf('tool-group-toggle').startsWith('<button')).toBe(true);
    expect(tagOf('tool-group-toggle')).toContain('aria-expanded="false"');
  });
});
