/**
 * The tombstone of a per-project SINGLETON view (board, git, files, processes).
 *
 * @covers LAYOUT-31
 *
 * THE BUG IT CLOSES, reported on 30/08: close the board tab, reload, it is
 * back. The project hydrate is a UNION over the persisted `nonChatPanes`
 * snapshot, and that snapshot outlives a close committed at unload - where the
 * React persistence effect never re-runs to drop the pane. Terminals and
 * browsers were already protected by a tombstone of their own; the singleton
 * views were not.
 */
import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { addViewTombstone, clearViewTombstone, getViewTombstones, viewTombstoneKey } from './closedTabRecord';

const store: Record<string, string> = {};
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  key: () => null,
  length: 0,
} as unknown as Storage;

// Restore bun's baseline (no global localStorage): do not leave it mounted for
// the later files of the same sharded process.
afterAll(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

const PROJECT = '/tmp/progetto';

describe('la lapide di una vista singleton', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

  test('closing one records it, and the record survives a reload', () => {
    addViewTombstone(PROJECT, 'kanban');
    expect(getViewTombstones().has(viewTombstoneKey(PROJECT, 'kanban'))).toBe(true);
  });

  test('it is keyed by project AND type: another project keeps its own board', () => {
    // A singleton view is created with a random uuid, so the pane id cannot be
    // the key. Getting this wrong would close every project's board at once.
    addViewTombstone(PROJECT, 'kanban');
    expect(getViewTombstones().has(viewTombstoneKey('/tmp/altro', 'kanban'))).toBe(false);
    expect(getViewTombstones().has(viewTombstoneKey(PROJECT, 'git'))).toBe(false);
  });

  test('reopening lifts it - otherwise the view could never come back', () => {
    // The half that matters as much as the first: a tombstone that outlives the
    // user's next click turns "closed" into "gone", and the hydrate would keep
    // filtering the pane straight back out.
    addViewTombstone(PROJECT, 'kanban');
    clearViewTombstone(PROJECT, 'kanban');
    expect(getViewTombstones().has(viewTombstoneKey(PROJECT, 'kanban'))).toBe(false);
  });

  test('closing twice leaves ONE record, not two', () => {
    addViewTombstone(PROJECT, 'kanban');
    addViewTombstone(PROJECT, 'kanban');
    expect([...getViewTombstones()].filter((k) => k === viewTombstoneKey(PROJECT, 'kanban')).length).toBe(1);
  });

  test('a project path with a colon in it still keys uniquely', () => {
    // The separator is `::`; a single colon inside a path must not collide.
    addViewTombstone('/tmp/a:b', 'git');
    expect(getViewTombstones().has(viewTombstoneKey('/tmp/a:b', 'git'))).toBe(true);
    expect(getViewTombstones().has(viewTombstoneKey('/tmp/a', 'b::git'))).toBe(false);
  });
});
