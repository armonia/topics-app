/**
 * The open sub-agent card prints the description only when the row's one-line
 * summary is really clipped on screen. Measured in the DOM (ToolCallRow), handed
 * here as `summaryCut`: the card does not guess from the length of the text.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo). The measured
 * outcome itself is checked by the e2e spec sub-agent-description-cut.
 *
 * @covers CHAT-TOOL-14
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolCallDetail } from '../../types';
import { ToolCardBody } from './ToolCards';

const LONG = 'Controlla ogni file del modulo di pagamento e riporta le differenze trovate, '.repeat(4).slice(0, 220);

function subAgent(description: string): ToolCallDetail {
  return { type: 'sub_agent', subAgentType: 'Explore', description, actions: [] } as ToolCallDetail;
}

function render(detail: ToolCallDetail, summaryCut: boolean): string {
  return renderToStaticMarkup(createElement(ToolCardBody, { detail, summaryCut }));
}

describe('sub-agent card body', () => {
  test('a description the row cuts is printed whole, with no truncate class', () => {
    expect(LONG.length).toBe(220);
    const html = render(subAgent(LONG), true);
    expect(html).toContain(LONG);
    expect(html).not.toContain('truncate');
  });

  test('a description the row shows whole is not printed again', () => {
    const html = render(subAgent(LONG), false);
    expect(html).not.toContain(LONG);
    expect(html).not.toContain('sub-agent-description');
  });

  test('a description that only repeats the type is never printed', () => {
    const same = subAgent('Explore');
    expect(render(same, true)).not.toContain('sub-agent-description');
    expect(render(same, false)).not.toContain('sub-agent-description');
  });

  test('the open body has no box: rows and description carry no tint or border', () => {
    const detail = {
      type: 'sub_agent', subAgentType: 'Explore', description: 'Controlla',
      actions: [{ index: 0, toolName: 'Read', summary: 'a.ts', status: 'success' }],
      result: 'ok',
    } as ToolCallDetail;
    const html = render(detail, false);
    expect(html).not.toMatch(/\bborder/);
    expect(html).not.toContain('tool-card-code');
    expect(html).toContain('data-testid="sub-agent-result"');
  });

  test('the final answer is the only band: soft tint and rounded corners, in both themes', () => {
    const detail = {
      type: 'sub_agent', subAgentType: 'Explore', description: 'Controlla',
      actions: [{ index: 0, toolName: 'Read', summary: 'a.ts', status: 'success' }],
      result: 'ok',
    } as ToolCallDetail;
    const html = render(detail, false);
    const band = html.match(/<div data-testid="sub-agent-result" class="([^"]*)"/);
    expect(band).not.toBeNull();
    expect(band![1]).toContain('bg-app-hover/40');
    expect(band![1]).toContain('rounded-lg');
    expect(band![1]).not.toContain('dark:');
    expect(html.match(/\bbg-/g)?.length).toBe(1);
  });
});
