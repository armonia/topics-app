/**
 * The feature map as pure reads of the hub's `/api/features`: systems named
 * without the repository in brackets and ranked, Jarvis's share and place per
 * area, who has a feature and who has it in part, news with safe links only,
 * the filters (behind, news, to build, chosen not now), the decision and the
 * note on a feature, every other system with its status, the evidence links,
 * the area's best other and the group's share. Inputs are the hub's own
 * shapes, trimmed, with placeholder systems.
 * @covers HUBBR-18
 */
import { describe, expect, test } from 'bun:test';
import { featuresView, filterCounts, localizeFeatures, systemName, visibleAreas } from './hubFeatures';

const MAP = {
  meta: { updated: '2026-11-03', checked: '2026-11-06T08:15:04Z' },
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
        ranking: [{ id: 'alpha', pct: 100 }, { id: 'jarvis', pct: 50 }],
        children: [
          {
            id: 'ch.wa', name: 'WhatsApp', desc: 'Native WhatsApp bridge', keywords: ['baileys'],
            status: { jarvis: 'yes', alpha: 'yes', beta: 'partial', gamma: 'no' }, ours: 'yes', have: 1, of: 3, behind: false,
            note: 'through the bridge', sources: ['https://docs.example.com/channels', 'javascript:alert(1)'],
            news: [
              { system: 'example/alpha', title: 'render headings', url: 'https://example.com/c/1', date: '2026-11-03T07:23:23Z' },
              { system: 'example/beta', title: 'bad link', url: 'javascript:alert(1)', date: 'not a date' },
            ],
          },
          { id: 'ch.sig', name: 'Signal', desc: '', status: { jarvis: 'no', alpha: 'yes', gamma: 'yes' }, ours: 'no', have: 3, of: 3, behind: true, news: [], plan: { kind: 'scelta', why: 'Nobody uses it' } },
          { id: 'ch.sms', name: 'SMS', desc: '', status: { jarvis: 'no' }, ours: 'no', have: 0, of: 3, behind: false, news: [], plan: { kind: 'sviluppo', prio: 2, why: 'Second' } },
          { id: 'ch.irc', name: 'IRC', desc: '', status: { jarvis: 'no' }, ours: 'no', have: 0, of: 3, behind: false, news: [], plan: { kind: 'sviluppo', prio: 1, why: 'First' } },
          { id: 'ch.odd', name: 'Odd', desc: '', status: { jarvis: 'no' }, ours: 'no', have: 0, of: 3, behind: false, news: [], plan: { kind: 'someday', why: 'x' } },
        ],
      }],
    },
    { id: 'memory', name: 'Memory', ranking: [{ id: 'jarvis', pct: 50 }, { id: 'beta', pct: 40 }], children: [{ id: 'm', name: 'Recall', children: [{ id: 'm.v', name: 'Vector recall', status: { jarvis: 'partial' }, ours: 'partial', have: 0, of: 3, behind: false, news: [] }] }] },
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
    expect(v.areas[1]!.oursPct).toBe(50);
  });

  test('the area says who leads it and by how much, the group its own share', () => {
    expect(v.areas[0]!.best).toEqual({ name: 'Alpha', pct: 100, rank: 1 });
    expect(v.areas[0]!.groups).toEqual([{ id: 'ch.chat', name: 'Chat platforms', oursPct: 50 }]);
    // Jarvis first: the best of the others comes after it.
    expect(v.areas[1]!.best).toEqual({ name: 'Beta', pct: 40, rank: 2 });
    expect(v.areas[1]!.groups[0]!.oursPct).toBeNull();
  });

  test('a feature carries the note, the decision, every other system and only safe sources', () => {
    const [wa, sig, , , odd] = v.areas[0]!.leaves;
    expect(wa!.note).toBe('through the bridge');
    expect(wa!.plan).toBeNull();
    expect(wa!.sources).toEqual(['https://docs.example.com/channels']);
    expect(wa!.cells).toEqual([{ name: 'Alpha', status: 'yes' }, { name: 'Beta', status: 'partial' }, { name: 'Gamma', status: 'no' }]);
    // A system the map says nothing about reads unknown, never no, and goes last.
    expect(sig!.cells).toEqual([{ name: 'Alpha', status: 'yes' }, { name: 'Gamma', status: 'yes' }, { name: 'Beta', status: 'unknown' }]);
    expect(sig!.plan).toEqual({ kind: 'scelta', prio: null, why: 'Nobody uses it' });
    expect(odd!.plan).toBeNull();
  });

  test('the decisions counted, the ones to build by priority, the watcher\'s last look', () => {
    expect(v.plans).toEqual({ sviluppo: 2, topics: 0, altro: 0, scelta: 1, fatto: 0 });
    expect(v.todo.map((l) => l.id)).toEqual(['ch.irc', 'ch.sms']);
    expect(v.checked).toBe('2026-11-06T08:15:04Z');
    expect(v.withNews).toBe(1);
    expect(filterCounts(v)).toEqual({ behind: 1, all: 3, news: 1, todo: 2, choice: 1 });
  });

  test('news keep only http links and real dates', () => {
    const [good, bad] = v.areas[0]!.leaves[0]!.news;
    expect(good).toEqual({ title: 'render headings', url: 'https://example.com/c/1', at: Date.parse('2026-11-03T07:23:23Z'), source: 'alpha' });
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
    expect(visibleAreas(v, 'all', '').flatMap((a) => a.leaves)).toHaveLength(6);
  });
});

describe('the filters beyond behind', () => {
  const v = featuresView(MAP)!;
  const ids = (f: Parameters<typeof visibleAreas>[1]) => visibleAreas(v, f, '').flatMap((a) => a.leaves.map((l) => l.id));
  test('news keeps the features with news, to build and chosen keep their decision', () => {
    expect(ids('news')).toEqual(['ch.wa']);
    expect(ids('todo')).toEqual(['ch.sms', 'ch.irc']);
    expect(ids('choice')).toEqual(['ch.sig']);
  });
});

describe('localizeFeatures', () => {
  const v = featuresView(MAP)!;
  const words = { 'a:channels': ['Canali e messaggi'], 'g:ch.chat': ['Piattaforme di chat'], 'ch.wa': ['WhatsApp', 'Ponte WhatsApp nativo'] } as const;
  test('areas, groups and features take the Italian; an unknown id keeps the hub English', () => {
    const it = localizeFeatures(v, words);
    expect(it.areas[0]!.name).toBe('Canali e messaggi');
    expect(it.areas[0]!.leaves[0]).toMatchObject({ name: 'WhatsApp', desc: 'Ponte WhatsApp nativo', group: 'Piattaforme di chat' });
    expect(it.areas[0]!.leaves[1]).toMatchObject({ name: 'Signal', group: 'Piattaforme di chat' });
    expect(it.areas[1]!.name).toBe('Memory');
    expect(it.areas[1]!.leaves[0]!.name).toBe('Vector recall');
    expect(it.areas[0]!.groups[0]!.name).toBe('Piattaforme di chat');
  });
  test('the search still finds a feature by its English words', () => {
    const it = localizeFeatures(v, words);
    expect(visibleAreas(it, 'all', 'native whatsapp bridge').flatMap((a) => a.leaves.map((l) => l.id))).toEqual(['ch.wa']);
    expect(visibleAreas(it, 'all', 'ponte').flatMap((a) => a.leaves.map((l) => l.id))).toEqual(['ch.wa']);
  });
  test('no word list, the same view', () => {
    expect(localizeFeatures(v, null)).toBe(v);
  });
});

test('systemName drops the repository in brackets', () => {
  expect(systemName('Jarvis (jarvis-channels)', 'jarvis')).toBe('Jarvis');
  expect(systemName(undefined, 'goose')).toBe('goose');
});
