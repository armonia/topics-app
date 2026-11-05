/**
 * The feature map as pure reads of the hub's `/api/features`: systems named
 * without the repository in brackets and ranked, Jarvis's share and place per
 * area, who has a feature and who has it in part, news with safe links only,
 * and the filter that keeps where Jarvis is behind. Inputs are the hub's own
 * shapes, trimmed, with placeholder systems.
 * @covers HUBBR-18
 */
import { describe, expect, test } from 'bun:test';
import { featuresView, systemName, visibleAreas } from './hubFeatures';

const MAP = {
  meta: { updated: '2026-11-03' },
  systems: [
    { id: 'jarvis', name: 'Jarvis (jarvis-channels)' },
    { id: 'alpha', name: 'Alpha' },
    { id: 'beta', name: 'Beta' },
    { id: 'gamma', name: 'Gamma' },
  ],
  ranking: [{ id: 'alpha', pct: 80, known: 3 }, { id: 'jarvis', pct: 67, known: 3 }, { id: 'beta', pct: 50, known: 3 }],
  totals: { leaves: 3, behind: 1, withNews: 1 },
  areas: [
    {
      id: 'channels', name: 'Channels and messaging',
      ranking: [{ id: 'alpha', pct: 100 }, { id: 'beta', pct: 75 }, { id: 'jarvis', pct: 50 }],
      children: [{
        id: 'ch.chat', name: 'Chat platforms',
        children: [
          {
            id: 'ch.wa', name: 'WhatsApp', desc: 'Native WhatsApp bridge', keywords: ['baileys'],
            status: { jarvis: 'yes', alpha: 'yes', beta: 'partial', gamma: 'no' }, ours: 'yes', have: 1, of: 3, behind: false,
            news: [
              { system: 'example/alpha', title: 'render headings', url: 'https://example.com/c/1', date: '2026-11-03T07:23:23Z' },
              { system: 'example/beta', title: 'bad link', url: 'javascript:alert(1)', date: 'not a date' },
            ],
          },
          { id: 'ch.sig', name: 'Signal', desc: '', status: { jarvis: 'no', alpha: 'yes', beta: 'yes', gamma: 'yes' }, ours: 'no', have: 3, of: 3, behind: true, news: [] },
        ],
      }],
    },
    { id: 'memory', name: 'Memory', ranking: [], children: [{ id: 'm', name: 'Recall', children: [{ id: 'm.v', name: 'Vector recall', status: { jarvis: 'partial' }, ours: 'partial', have: 0, of: 3, behind: false, news: [] }] }] },
  ],
};

describe('featuresView', () => {
  const v = featuresView(MAP)!;

  test('the verdict: how many behind out of how many, Jarvis second of the ranked', () => {
    expect(v.leaves).toBe(3);
    expect(v.behind).toBe(1);
    expect(v.updated).toBe('2026-11-03');
    expect(v.ours).toEqual({ id: 'jarvis', name: 'Jarvis', pct: 67, rank: 2 });
    expect(v.systems.map((s) => s.name)).toEqual(['Alpha', 'Jarvis', 'Beta', 'Gamma']);
  });

  test('an area carries Jarvis\'s share and place, and its leaves who has them', () => {
    const ch = v.areas[0]!;
    expect([ch.oursPct, ch.oursRank, ch.behind]).toEqual([50, 3, 1]);
    const wa = ch.leaves[0]!;
    expect(wa.group).toBe('Chat platforms');
    expect(wa.withIt).toEqual(['Alpha']);
    expect(wa.partly).toEqual(['Beta']);
    expect(v.areas[1]!.oursPct).toBeNull();
  });

  test('news keep only http links and real dates', () => {
    const [good, bad] = v.areas[0]!.leaves[0]!.news;
    expect(good).toEqual({ title: 'render headings', url: 'https://example.com/c/1', at: Date.parse('2026-11-03T07:23:23Z'), source: 'example/alpha' });
    expect(bad!.url).toBeNull();
    expect(bad!.at).toBeNull();
  });

  test('not a map, no view', () => {
    expect(featuresView({ error: 'mappa non trovata' })).toBeNull();
    expect(featuresView(null)).toBeNull();
  });
});

describe('visibleAreas', () => {
  const v = featuresView(MAP)!;
  test('behind keeps only those, and an area left empty goes', () => {
    const a = visibleAreas(v, 'behind', '');
    expect(a.map((x) => x.id)).toEqual(['channels']);
    expect(a[0]!.leaves.map((l) => l.id)).toEqual(['ch.sig']);
  });
  test('the search reads names, descriptions, groups and keywords', () => {
    expect(visibleAreas(v, 'all', 'BAILEYS').flatMap((a) => a.leaves.map((l) => l.id))).toEqual(['ch.wa']);
    expect(visibleAreas(v, 'all', 'recall').flatMap((a) => a.leaves.map((l) => l.id))).toEqual(['m.v']);
    expect(visibleAreas(v, 'all', '').flatMap((a) => a.leaves)).toHaveLength(3);
  });
});

test('systemName drops the repository in brackets', () => {
  expect(systemName('Jarvis (jarvis-channels)', 'jarvis')).toBe('Jarvis');
  expect(systemName(undefined, 'goose')).toBe('goose');
});
