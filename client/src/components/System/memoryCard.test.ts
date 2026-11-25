/**
 * @covers SYSTEM-PAGE-01
 */
import { describe, expect, test } from 'bun:test';
import { parseCard, storeLabel } from './memoryCard';

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

describe('storeLabel', () => {
  const agents = [{ id: 'main', name: 'Main Agent' }];
  const projects = [{ name: 'Demo app', path: 'E:/work/demo' }, { name: 'Topics', path: '/srv/topics-app' }];
  test('agents and projects go by name, not id', () => {
    expect(storeLabel('agent:main', agents, projects)).toBe('Main Agent');
    expect(storeLabel('project:demo', agents, projects)).toBe('Demo app');
    expect(storeLabel('project:-srv-topics-app', agents, projects)).toBe('Topics');
    expect(storeLabel('agent:ghost', agents, projects)).toBe('ghost');
  });
});
