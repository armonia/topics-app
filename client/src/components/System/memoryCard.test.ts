import { describe, expect, test } from 'bun:test';
import { parseCard } from './memoryCard';

describe('parseCard', () => {
  test('reads type, date and links, once each', () => {
    const c = parseCard('---\nname: x\ntype: feedback\nupdated: 2026-11-01\n---\nSee [[other-card]] and [[other-card]] and [[third]].');
    expect(c).toMatchObject({ type: 'feedback', date: '2026-11-01', links: ['other-card', 'third'] });
    expect(c.body.startsWith('See')).toBe(true);
  });

  test('a card without front matter is all body', () => {
    expect(parseCard('just text')).toEqual({ type: '', date: null, links: [], body: 'just text' });
  });
});
