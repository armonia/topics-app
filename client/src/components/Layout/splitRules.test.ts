import { describe, it, expect } from 'bun:test';
import { canSplitPane, standaloneSplitSurface } from './splitRules';

describe('canSplitPane', () => {
  it('standalone pool is always splittable (single tab auto-spawns a draft companion)', () => {
    expect(canSplitPane({ surface: 'standalone-pool', groupSize: 1 })).toBe(true);
    expect(canSplitPane({ surface: 'standalone-pool', groupSize: 5 })).toBe(true);
  });

  it('solo cells split only when they hold more than one tab', () => {
    expect(canSplitPane({ surface: 'standalone-solo', groupSize: 1 })).toBe(false);
    expect(canSplitPane({ surface: 'standalone-solo', groupSize: 2 })).toBe(true);
  });

  it('project groups split only when another pane stays behind', () => {
    expect(canSplitPane({ surface: 'project', groupSize: 1 })).toBe(false);
    expect(canSplitPane({ surface: 'project', groupSize: 2 })).toBe(true);
    expect(canSplitPane({ surface: 'project', groupSize: 0 })).toBe(false);
  });
});

describe('standaloneSplitSurface', () => {
  it('maps grid keys to surfaces', () => {
    expect(standaloneSplitSurface('standalone')).toBe('standalone-pool');
    expect(standaloneSplitSurface('solo:abc')).toBe('standalone-solo');
  });
});
