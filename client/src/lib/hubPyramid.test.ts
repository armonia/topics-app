/**
 * The pyramid of what Jarvis needs as a pure read of the hub's `pyramid`:
 * levels drawn from the top down, the four colours counted per level, what is
 * needed and what is covered, the functions ordered with what moved first,
 * and the use left out where the map wrote no measure. Placeholder functions.
 * @covers HUBBR-18
 */
import { describe, expect, test } from 'bun:test';
import { pyramidView } from './hubPyramid';

const PYRAMID = {
  updated: '2026-11-03',
  levels: [
    { n: 1, name: 'Canali', desc: 'Da dove arrivano i messaggi', items: [
      { name: 'Chat A', where: 'src/a.rs', use: '36 turni', status: 'ok' },
      { name: 'Chat B', where: 'src/b.rs', use: '—', status: 'fatto', outcome: 'fatta, anche su B' },
      { name: 'Chat C', where: '', use: '?', status: 'lascia' },
    ] },
    { n: 2, name: 'Motore', desc: 'Chi esegue il turno', items: [
      { name: 'Turno', use: '4', status: 'motore', outcome: 'va nel motore unico' },
      { name: 'Riserva', status: 'no' },
      { name: 'Strano', status: 'boh' },
      { status: 'ok' },
    ] },
  ],
};

describe('pyramidView', () => {
  const p = pyramidView(PYRAMID)!;

  test('the top level first, the base last', () => {
    expect(p.levels.map((l) => l.n)).toEqual([2, 1]);
  });

  test('the summary: needed leaves out what is let go, covered counts done today and another way', () => {
    expect([p.needed, p.covered, p.doneToday, p.moving, p.missing, p.dropped]).toEqual([5, 2, 1, 2, 1, 1]);
    expect(p.updated).toBe('2026-11-03');
  });

  test('a level counts its colours and puts what moved first, the covered last', () => {
    const base = p.levels[1]!;
    expect(base.counts).toEqual({ ok: 2, warn: 0, bad: 0, off: 1 });
    expect([base.covered, base.needed]).toEqual([2, 2]);
    expect(base.items.map((i) => i.name)).toEqual(['Chat B', 'Chat C', 'Chat A']);
  });

  test('a dash or a question mark is no measure; an unknown status reads partial; a nameless function goes', () => {
    const base = p.levels[1]!;
    expect(base.items.find((i) => i.name === 'Chat A')!.use).toBe('36 turni');
    expect(base.items.find((i) => i.name === 'Chat B')!.use).toBeNull();
    expect(base.items.find((i) => i.name === 'Chat C')!).toMatchObject({ use: null, where: null });
    const top = p.levels[0]!;
    expect(top.items).toHaveLength(3);
    expect(top.items.find((i) => i.name === 'Strano')!.status).toBe('part');
  });

  test('no pyramid, no view', () => {
    expect(pyramidView(null)).toBeNull();
    expect(pyramidView({ levels: [] })).toBeNull();
  });
});
