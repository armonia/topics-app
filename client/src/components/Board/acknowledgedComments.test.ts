/** @covers KANBAN-73 */
import { describe, expect, test } from 'bun:test';
import type { TaskComment } from '../../../../shared/board';
import { reconcileAcknowledgedComments } from './acknowledgedComments';

const comment = (id: string, createdAt: string): TaskComment => ({
  id, taskId: 'task', author: 'user', content: id, createdAt, mentions: [], media: [], kind: 'comment', messageId: null,
});

describe('acknowledged task comments', () => {
  test('an older detail snapshot cannot retract a saved reply', () => {
    const old = comment('old', '2026-09-08T20:00:00Z');
    const saved = comment('saved', '2026-09-08T20:01:00Z');
    const acknowledgements = new Map([[saved.id, saved]]);
    expect(reconcileAcknowledgedComments([old], acknowledgements)).toEqual([old, saved]);
    expect(acknowledgements.size).toBe(1);
  });
  test('confirmation retires the acknowledgement without duplicating its row', () => {
    const saved = comment('saved', '2026-09-08T20:01:00Z');
    const acknowledgements = new Map([[saved.id, saved]]);
    const read = [{ ...saved, media: ['/tmp/confirmed.png'] }];
    expect(reconcileAcknowledgedComments(read, acknowledgements)).toBe(read);
    expect(acknowledgements.size).toBe(0);
  });
  test('remote comments and unconfirmed local replies retain chronological order', () => {
    const own = comment('own', '2026-09-08T20:01:00Z');
    const remote = comment('remote', '2026-09-08T20:02:00Z');
    expect(reconcileAcknowledgedComments([remote], new Map([[own.id, own]]))).toEqual([own, remote]);
  });
});
