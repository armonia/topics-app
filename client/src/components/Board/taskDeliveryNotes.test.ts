/** @covers KANBAN-73 */
import { expect, test } from 'bun:test';
import type { TaskComment } from '../../../../shared/board';
import { deliveryNotesToFold } from './taskDeliveryNotes';

const row = (id: string, kind: TaskComment['kind'] = 'comment', overrides: Partial<TaskComment> = {}): TaskComment => ({
  id, taskId: 'task', author: 'agent:one', messageId: 'turn', kind,
  content: 'The source can be added.', media: [], mentions: [], createdAt: '2026-09-08T15:00:00Z', ...overrides,
});

test('only supplementary delivery notes from the same author and turn fold', () => {
  const rows = [
    row('earlier', 'delivery'), row('reply'), row('note', 'delivery'),
    row('other-turn', 'delivery', { messageId: 'other' }),
    row('other-agent', 'delivery', { author: 'agent:two' }),
    row('unanchored', 'delivery', { messageId: null }),
    row('attachment', 'delivery', { media: ['/result.svg'] }),
    row('question', 'delivery', { content: '```question\nWhich source?\n- Orders\n- Contracts\n```' }),
    row('prose-question', 'delivery', { content: 'Which source should I use?' }),
    row('markdown-image', 'delivery', { content: '![Result](/api/media?path=result.svg)' }),
    row('markdown-file', 'delivery', { content: '[Result](/result.csv)' }),
  ];
  expect([...deliveryNotesToFold(rows)]).toEqual(['note']);
});

test('a question, user comment or empty reply is not a substitute for the delivery', () => {
  for (const reply of [
    row('question', 'comment', { content: '```question\nWhich source?\n- Orders\n- Contracts\n```' }),
    row('human', 'comment', { author: 'user' }), row('empty', 'comment', { content: ' ' }),
  ]) expect([...deliveryNotesToFold([reply, row('delivery', 'delivery')])]).toEqual([]);
});
