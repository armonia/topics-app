import { describe, expect, test } from 'bun:test';
import { openedByLabel } from './createdByLabel';

const tr = (key: string, params?: Record<string, string | number>) => `${key}:${params?.name ?? ''}`;

describe('openedByLabel', () => {
  test('a chat agent says the name of its chat, an anonymous caller says nothing', () => {
    expect(openedByLabel('agent:session', 'backlog', tr, 'Fix the loader')).toBe('board.card.createdByChat:Fix the loader');
    expect(openedByLabel('agent:session', 'backlog', tr)).toBe('board.card.createdBySession:');
    expect(openedByLabel('agent:api', 'backlog', tr)).toBeNull();
    expect(openedByLabel(null, 'backlog', tr)).toBeNull();
  });
});
