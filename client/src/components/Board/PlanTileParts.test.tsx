/**
 * A Plan tile shows the «waiting for you» box only when the server listed
 * something, and its header says when the group is at work.
 *
 * @covers KANBAN-105
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityBadge, NeedsYouBox } from './PlanTileParts';

const noop = () => {};

describe('Plan tile parts', () => {
  test('a tile with needsYou shows the box, one clickable row per item', () => {
    const html = renderToStaticMarkup(createElement(NeedsYouBox, { onOpenTask: noop, needs: [
      { taskId: 't1', text: 'Card one', reason: 'review' },
      { taskId: 't2', text: 'Card two', reason: 'question', detail: 'Postgres or SQLite?' },
    ] }));
    expect(html).toContain('data-testid="plan-needs-you"');
    expect(html.match(/data-testid="plan-need"/g)?.length).toBe(2);
    expect(html).toContain('Postgres or SQLite?');
  });

  test('a tile without needsYou shows no box', () => {
    expect(renderToStaticMarkup(createElement(NeedsYouBox, { onOpenTask: noop, needs: [] }))).toBe('');
  });

  test('the header shows the working loader only when at work', () => {
    const working = renderToStaticMarkup(createElement(ActivityBadge, { activity: { state: 'working', count: 2 } }));
    expect(working).toContain('data-state="working"');
    expect(working).toContain('<canvas');
    const review = renderToStaticMarkup(createElement(ActivityBadge, { activity: { state: 'review', count: 1 } }));
    expect(review).not.toContain('<canvas');
    expect(review).toContain('<svg');
    expect(renderToStaticMarkup(createElement(ActivityBadge, { activity: { state: 'empty', count: 0 } }))).toBe('');
  });
});
