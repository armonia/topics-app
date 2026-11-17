/**
 * The chevron of a tool row is a hover/focus cue, not a permanent glyph.
 *
 * It is hidden until the row is hovered or focused, touch (`coarse:`) shows it
 * always, and its 12px column is reserved in every state so the label never
 * moves when it appears. Rendered with `renderToStaticMarkup` (no DOM in this
 * repo): the class contract is checked here, the measured no-shift is in the
 * e2e spec.
 *
 * @covers CHAT-TOOL-14
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
  test('a row with a body keeps its 12px slot AFTER the text and hides the chevron until hover/focus', () => {
    const html = renderToStaticMarkup(createElement(ToolCallRow, { toolCall: failedBash }));
    expect(html).toContain('w-3 flex-shrink-0');
    expect(html).toContain('opacity-0');
    expect(html).toContain('group-hover/tool:opacity-100');
    expect(html).toContain('group-focus-within/tool:opacity-100');
    // No empty column on the left: the icon comes first, the chevron after the name.
    expect(html.indexOf('w-3 flex-shrink-0')).toBeGreaterThan(html.indexOf('data-testid="tool-call-name"'));
  });

  test('touch shows the chevron always', () => {
    const html = renderToStaticMarkup(createElement(ToolCallRow, { toolCall: failedBash }));
    expect(html).toContain('coarse:opacity-100');
  });

  test('a sub-agent row is on the same grid: the chevron cue, a name and its line, no parentheses', () => {
    const subAgent: ToolCall = {
      id: 'chevron-sub',
      name: 'Task',
      args: { subagent_type: 'Explore', description: 'Controlla il modulo di pagamento' },
      status: 'success',
      result: 'ok',
    };
    const html = renderToStaticMarkup(createElement(ToolCallRow, { toolCall: subAgent }));
    expect(html).toContain('Controlla il modulo di pagamento');
    expect(html).toContain('data-testid="tool-call-name"');
    expect(html).toContain('>Sub-agent<');
    expect(html).toContain('data-work-kind="subagent"');
    expect(html).toContain('group-hover/tool:opacity-100');
    expect(html).not.toContain('>(<');
    expect(html).toContain('title="Sub-agent · Explore');
  });

  test('a sub-agent call with no description is not an empty row (the bare robot)', () => {
    for (const toolCall of [
      { id: 'e1', name: 'Task', args: {}, status: 'running' },
      { id: 'e2', name: 'spawn_agent', args: {}, status: 'running' },
      { id: 'e3', name: 'Task', args: {}, status: 'success', result: 'ok' },
      { id: 'e4', name: 'Task', args: {}, status: 'error', error: 'boom' },
    ] as ToolCall[]) {
      const html = renderToStaticMarkup(createElement(ToolCallRow, { toolCall }));
      expect(html).toMatch(/data-testid="tool-call-name"[^>]*>Sub-agent</);
    }
  });

  test('a finished sub-agent call with nothing at all is not drawn; a failed one is', () => {
    const nothing = renderToStaticMarkup(createElement(ToolCallRow, { toolCall: { id: 'n1', name: 'Task', args: {}, status: 'success' } as ToolCall }));
    expect(nothing).toBe('');
    const failed = renderToStaticMarkup(createElement(ToolCallRow, { toolCall: { id: 'n2', name: 'Task', args: {}, status: 'error', error: 'boom' } as ToolCall }));
    expect(failed).toMatch(/data-testid="tool-call-name"[^>]*>Sub-agent</);
  });

  test('background work is its own kind: another name, not the sub-agent\'s', () => {
    const html = renderToStaticMarkup(createElement(ToolCallRow, {
      toolCall: { id: 'bg1', name: 'run_command', args: { command: 'bun run dev' }, status: 'success', result: 'started · processId=p1' },
    }));
    expect(html).toContain('data-work-kind="background"');
    expect(html).toMatch(/data-testid="tool-call-name"[^>]*>Background</);
  });

  test('the running tool is flat: no tint, no ring, no negative margin', () => {
    const html = renderToStaticMarkup(createElement(ToolCallRow, {
      toolCall: { id: 'run1', name: 'Bash', args: { command: 'bun test' }, status: 'running', startedAt: 1 },
    }));
    expect(html).not.toContain('bg-primary/5');
    expect(html).not.toContain('ring-primary');
    expect(html).not.toContain('-mx-1.5');
  });
});
