/**
 * THE SWATCH, NOT A STATUS LIGHT.
 *
 * Pins the shape that makes `TopicColorDot` unambiguous against every round
 * state dot in the sidebar (`STATUS_DOT`, the attention fill, the inbox's
 * busy dot): a square corner radius, never `rounded-full`. Mounted with
 * `renderToStaticMarkup` (no DOM library in this project), same pattern as
 * `Segmented.test.tsx`.
 *
 * @covers SIDEBAR-COLOR-01
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopicColorDot } from './TopicColorDot';

describe('TopicColorDot', () => {
  test('a chosen colour paints a square swatch, never a round dot', () => {
    const html = renderToStaticMarkup(<TopicColorDot color="#dc2626" />);
    expect(html).toContain('rounded-[2px]');
    expect(html).not.toContain('rounded-full');
  });

  test('hidden from the accessibility tree: the name is what identifies the topic', () => {
    const html = renderToStaticMarkup(<TopicColorDot color="#dc2626" />);
    expect(html).toContain('aria-hidden="true"');
  });

  test('a default colour (never chosen by a person) paints nothing', () => {
    expect(renderToStaticMarkup(<TopicColorDot color="#5865f2" />)).toBe('');
    expect(renderToStaticMarkup(<TopicColorDot color={null} />)).toBe('');
    expect(renderToStaticMarkup(<TopicColorDot color={undefined} />)).toBe('');
  });
});
