/**
 * The weight a project column carries in the grid, the registry that holds
 * those weights, and the change notifications that trigger a rebalance.
 *
 * @covers LAYOUT-01
 */
import { describe, test, expect } from 'bun:test';
import { computeProjectGridWeight, setProjectGridWeight, getProjectGridWeight, clearProjectGridWeight, subscribeProjectGridWeights } from './projectGridWeights';
import type { GroupLayoutRow } from '../types';

const row = (groupIds: string[], cellStacks?: GroupLayoutRow['cellStacks']): GroupLayoutRow => ({
  groupIds,
  widths: groupIds.map(() => 1 / groupIds.length),
  ...(cellStacks ? { cellStacks } : {}),
});

describe('computeProjectGridWeight', () => {
  test('empty / nullish layout → a single unsplit cell (weight 1×1)', () => {
    expect(computeProjectGridWeight(undefined)).toEqual({ cols: 1, rows: 1 });
    expect(computeProjectGridWeight(null)).toEqual({ cols: 1, rows: 1 });
    expect(computeProjectGridWeight([])).toEqual({ cols: 1, rows: 1 });
  });

  test('single row of 3 columns → cols 3, rows 1', () => {
    expect(computeProjectGridWeight([row(['a', 'b', 'c'])])).toEqual({ cols: 3, rows: 1 });
  });

  test('three stacked rows of 1 column → cols 1, rows 3', () => {
    expect(computeProjectGridWeight([row(['a']), row(['b']), row(['c'])])).toEqual({ cols: 1, rows: 3 });
  });

  test('cols = the WIDEST row, not the first', () => {
    expect(computeProjectGridWeight([row(['a']), row(['b', 'c', 'd'])])).toEqual({ cols: 3, rows: 2 });
  });

  test('a vertical sub-stack (cellStacks) adds to the row depth', () => {
    // row with 2 columns; column "a" has a 2-deep stack under it (2 extra groups)
    // → that row is 3 leaves tall (primary + 2), cols = 2.
    const r = row(['a', 'b'], { a: { groupIds: ['a2', 'a3'], heights: [0.5, 0.5] } });
    expect(computeProjectGridWeight([r])).toEqual({ cols: 2, rows: 3 });
  });

  test('row depth = the DEEPEST column in that row', () => {
    const r = row(['a', 'b'], {
      a: { groupIds: ['a2'], heights: [1] },          // depth 2
      b: { groupIds: ['b2', 'b3', 'b4'], heights: [] }, // depth 4
    });
    // two rows: this deep one (depth 4) + a plain single → rows 4 + 1 = 5
    expect(computeProjectGridWeight([r, row(['c'])])).toEqual({ cols: 2, rows: 5 });
  });
});

describe('projectGridWeights registry', () => {
  test('set / get / clear round-trips', () => {
    const path = '/tmp/test-project-xyz';
    expect(getProjectGridWeight(path)).toBeUndefined();
    setProjectGridWeight(path, { cols: 2, rows: 3 });
    expect(getProjectGridWeight(path)).toEqual({ cols: 2, rows: 3 });
    clearProjectGridWeight(path);
    expect(getProjectGridWeight(path)).toBeUndefined();
  });
});

describe('projectGridWeights change notifications (auto-rebalance trigger)', () => {
  // Notifications are coalesced to a microtask; this flushes one tick AFTER the
  // pending notify callback (queueMicrotask is FIFO).
  const flush = () => new Promise<void>((r) => queueMicrotask(r));

  test('first publish and same-value re-publish do NOT notify; a real change does', async () => {
    const p = '/tmp/notify-change';
    const seen: Array<ReadonlySet<string>> = [];
    const unsub = subscribeProjectGridWeights((c) => seen.push(c));
    setProjectGridWeight(p, { cols: 1, rows: 1 }); // first publish (restoring layout) — must be silent
    await flush();
    expect(seen).toHaveLength(0);
    setProjectGridWeight(p, { cols: 1, rows: 1 }); // same value (e.g. an inner RESIZE) — silent
    await flush();
    expect(seen).toHaveLength(0);
    setProjectGridWeight(p, { cols: 2, rows: 1 }); // split added → notify
    await flush();
    expect(seen).toHaveLength(1);
    expect([...seen[0]]).toContain(p);
    unsub();
    clearProjectGridWeight(p);
    await flush();
  });

  test('clear + re-publish of the SAME weight in one tick is silent (inner resize)', async () => {
    // What every re-run of ProjectWindow's publish effect looks like from here:
    // cleanup clears, body sets it straight back. Dragging a divider inside a
    // project window did exactly this (a new `rows` array, same shape), and the
    // clear's notification made PanelGrid rebalance the OUTER grid to an equal
    // split — so resizing one project's split threw away the whole grid's row
    // heights. Netting the batch against the settled registry is what keeps a
    // no-op silent; a remount and StrictMode's double-invoke are the same shape.
    const p = '/tmp/notify-clear-reset';
    setProjectGridWeight(p, { cols: 2, rows: 1 });
    await flush();
    const seen: Array<ReadonlySet<string>> = [];
    const unsub = subscribeProjectGridWeights((c) => seen.push(c));
    clearProjectGridWeight(p);
    setProjectGridWeight(p, { cols: 2, rows: 1 }); // same extent, new rows array
    await flush();
    expect(seen).toHaveLength(0);
    // A clear followed by a genuinely different weight is still a change.
    clearProjectGridWeight(p);
    setProjectGridWeight(p, { cols: 3, rows: 1 });
    await flush();
    expect(seen).toHaveLength(1);
    expect([...seen[0]]).toContain(p);
    unsub();
    clearProjectGridWeight(p);
    await flush();
  });

  test('clearing an existing entry notifies (tab swap); clearing a missing one does not', async () => {
    const p = '/tmp/notify-clear';
    setProjectGridWeight(p, { cols: 1, rows: 1 });
    await flush();
    const seen: Array<ReadonlySet<string>> = [];
    const unsub = subscribeProjectGridWeights((c) => seen.push(c));
    clearProjectGridWeight(p);
    await flush();
    expect(seen).toHaveLength(1);
    clearProjectGridWeight(p); // already gone
    await flush();
    expect(seen).toHaveLength(1);
    unsub();
  });

  test('multiple changes in one tick coalesce into a single batched notification', async () => {
    const a = '/tmp/notify-a', b = '/tmp/notify-b';
    setProjectGridWeight(a, { cols: 1, rows: 1 });
    setProjectGridWeight(b, { cols: 1, rows: 1 });
    await flush();
    const seen: Array<ReadonlySet<string>> = [];
    const unsub = subscribeProjectGridWeights((c) => seen.push(c));
    setProjectGridWeight(a, { cols: 2, rows: 1 });
    setProjectGridWeight(b, { cols: 3, rows: 1 });
    await flush();
    expect(seen).toHaveLength(1);
    expect([...seen[0]].sort()).toEqual([a, b].sort());
    unsub();
    clearProjectGridWeight(a);
    clearProjectGridWeight(b);
    await flush();
  });

  test('unsubscribe stops delivery', async () => {
    const p = '/tmp/notify-unsub';
    setProjectGridWeight(p, { cols: 1, rows: 1 });
    await flush();
    const seen: Array<ReadonlySet<string>> = [];
    const unsub = subscribeProjectGridWeights((c) => seen.push(c));
    unsub();
    setProjectGridWeight(p, { cols: 2, rows: 1 });
    await flush();
    expect(seen).toHaveLength(0);
    clearProjectGridWeight(p);
    await flush();
  });
});
