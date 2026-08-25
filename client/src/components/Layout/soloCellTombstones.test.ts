/**
 * Tombstones that let a reopened topic return to the cell and slot it was
 * closed from, including when the whole cell dissolved, and that expire.
 *
 * @covers LAYOUT-01
 */
import { describe, it, expect } from 'bun:test';
import {
  recordSoloTombstones,
  restoreFromSoloTombstones,
  SOLO_TOMBSTONE_TTL_MS,
  type SoloCellTombstone,
} from './soloCellTombstones';

const NOW = 1_000_000;

describe('recordSoloTombstones', () => {
  it('records a closed cell member with its mates and slot', () => {
    const prev = [['A', 'B', 'C']];
    const next = [['A', 'C']]; // B pruned
    const out = recordSoloTombstones([], prev, next, new Set(['A', 'C']), NOW);
    expect(out).toEqual([{ topicId: 'B', cellMates: ['A', 'C'], index: 1, closedAt: NOW }]);
  });

  it('records the last tab of a dissolving cell with no mates', () => {
    const out = recordSoloTombstones([], [['A']], [], new Set(), NOW);
    expect(out).toEqual([{ topicId: 'A', cellMates: [], index: 0, closedAt: NOW }]);
  });

  it('does NOT record an unsolo (topic left the cell but is still open)', () => {
    const out = recordSoloTombstones([], [['A', 'B']], [['A']], new Set(['A', 'B']), NOW);
    expect(out.length).toBe(0);
  });

  it('returns the same ref when nothing closed', () => {
    const tombs: SoloCellTombstone[] = [];
    expect(recordSoloTombstones(tombs, [['A']], [['A']], new Set(['A']), NOW)).toBe(tombs);
  });

  it('replaces a stale tombstone for the same topic', () => {
    const old: SoloCellTombstone[] = [{ topicId: 'B', cellMates: ['X'], index: 0, closedAt: 1 }];
    const out = recordSoloTombstones(old, [['A', 'B']], [['A']], new Set(['A']), NOW);
    expect(out).toEqual([{ topicId: 'B', cellMates: ['A'], index: 1, closedAt: NOW }]);
  });
});

describe('restoreFromSoloTombstones', () => {
  const tomb = (topicId: string, cellMates: string[], index: number, closedAt = NOW): SoloCellTombstone =>
    ({ topicId, cellMates, index, closedAt });

  it('merges a reopened topic back into its surviving cell at its old slot', () => {
    const res = restoreFromSoloTombstones([['A', 'C']], [tomb('B', ['A', 'C'], 1)], ['A', 'B', 'C'], NOW + 1000);
    expect(res.cellsChanged).toBe(true);
    expect(res.cells).toEqual([['A', 'B', 'C']]);
    expect(res.tombstones.length).toBe(0);
  });

  it('recreates an own cell when the whole cell dissolved', () => {
    const res = restoreFromSoloTombstones([], [tomb('A', [], 0)], ['A'], NOW + 1000);
    expect(res.cells).toEqual([['A']]);
    expect(res.cellsChanged).toBe(true);
  });

  it('follows a re-keyed cell via any surviving cell-mate', () => {
    // B closed from [A, B]; A's cell later re-keyed by merging into [C, A].
    const res = restoreFromSoloTombstones([['C', 'A']], [tomb('B', ['A'], 1)], ['A', 'B', 'C'], NOW + 1000);
    expect(res.cells).toEqual([['C', 'B', 'A']]);
  });

  it('ignores topics that are not open (still closed)', () => {
    const tombs = [tomb('B', ['A'], 1)];
    const res = restoreFromSoloTombstones([['A']], tombs, ['A'], NOW + 1000);
    expect(res.cellsChanged).toBe(false);
    expect(res.cells).toEqual([['A']]);
    expect(res.tombstones).toBe(tombs);
  });

  it('ignores topics already re-homed into a cell', () => {
    const res = restoreFromSoloTombstones([['B']], [tomb('B', ['A'], 1)], ['B'], NOW + 1000);
    expect(res.cellsChanged).toBe(false);
    expect(res.tombstones.length).toBe(0); // consumed anyway — no double restore later
  });

  it('expires tombstones past the TTL', () => {
    const res = restoreFromSoloTombstones([], [tomb('B', ['A'], 1, NOW)], ['B'], NOW + SOLO_TOMBSTONE_TTL_MS + 1);
    expect(res.cellsChanged).toBe(false);
    expect(res.tombstones.length).toBe(0);
  });
});
