/**
 * A 'user' comment that came through the API says "via API" once, not twice:
 * the author line already carries it, so the origin chip stays quiet.
 *
 * @covers KANBAN-113
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommentBubble } from './TaskDetail';
import type { TaskComment } from '../../../../shared/board';

function comment(over: Partial<TaskComment>): TaskComment {
  return { id: 'c1', taskId: 't1', author: 'user', content: 'ciao', createdAt: '2026-11-12T10:00:00.000Z', ...over } as TaskComment;
}
const count = (html: string) => (html.match(/via API/g) ?? []).length;

describe('CommentBubble origin label', () => {
  test('user row with origin api shows "via API" once', () => {
    const html = renderToStaticMarkup(<CommentBubble comment={comment({ origin: 'api' })} ownerName="Owner" />);
    expect(count(html)).toBe(1);
  });
  test('agent row with origin api keeps its origin chip', () => {
    const html = renderToStaticMarkup(<CommentBubble comment={comment({ author: 'agent:abc', origin: 'api' })} ownerName="Owner" />);
    expect(count(html)).toBe(1);
  });
});
