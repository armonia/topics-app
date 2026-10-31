/**
 * The chevron of a tool row is a hover/focus cue, not a permanent glyph.
 *
 * It is hidden until the row is hovered or focused, touch (`coarse:`) shows it
 * always, and its 12px column is reserved in every state so the label never
 * moves when it appears. Rendered with `renderToStaticMarkup` (no DOM in this
 * repo): the class contract is checked here, the measured no-shift is in the
 * e2e spec.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolCall } from '../../types';
import { ToolCallRow } from './ToolCallRow';

const failedBash: ToolCall = {
  id: 'chevron-1',
  name: 'Bash',
  args: { command: 'bun test' },
  status: 'error',
  error: 'exit 1: 3 tests failed',
};

describe('ToolCallRow chevron', () => {
  test('a row with a body reserves the 12px column and hides the chevron until hover/focus', () => {
    const html = renderToStaticMarkup(createElement(ToolCallRow, { toolCall: failedBash }));
    expect(html).toContain('w-3 flex-shrink-0');
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover/tool:opacity-100');
    expect(html).toContain('group-focus-within/tool:opacity-100');
  });

  test('touch shows the chevron always', () => {
    const html = renderToStaticMarkup(createElement(ToolCallRow, { toolCall: failedBash }));
    expect(html).toContain('coarse:opacity-100');
  });
});
