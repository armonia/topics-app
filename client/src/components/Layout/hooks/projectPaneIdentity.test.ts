/** @covers PANE-AUTH-04 */
import { describe, expect, test } from 'bun:test';
import type { Pane, PaneGroup } from '../../../types';
import { createProjectSingletonPaneId } from '../../../state/pane/adapters/paneConfig';
import { migrateProjectPaneIdentity } from './projectPaneIdentity';

const PROJECT = '/work/demo';
const GIT_ID = createProjectSingletonPaneId(PROJECT, 'git');
const pane = (id: string, type: Pane['type'] = 'git'): Pane => ({ id, type, title: id, preview: false } as Pane);
const group = (id: string, paneIds: string[]): PaneGroup =>
  ({ id, type: 'utility', paneIds, activePaneId: paneIds[0] } as PaneGroup);

describe('project singleton identity', () => {
  test('two devices name the same view alike, two projects do not', () => {
    expect(createProjectSingletonPaneId(PROJECT, 'git')).toBe(createProjectSingletonPaneId(PROJECT, 'git'));
    expect(GIT_ID).toBe(`git:${encodeURIComponent(PROJECT)}`);
    expect(createProjectSingletonPaneId('/work/other', 'git')).not.toBe(GIT_ID);
  });

  test('a legacy id takes the project id and keeps its rendering key', () => {
    const [migrated] = migrateProjectPaneIdentity(PROJECT, [pane('git:legacy')]).panes;
    expect(migrated?.id).toBe(GIT_ID);
    expect(migrated?.stableKey ?? migrated?.id).toBe('git:legacy');
  });

  test('of two copies the first in group order survives, and the groups follow', () => {
    const result = migrateProjectPaneIdentity(
      PROJECT,
      [pane('git:second'), pane('git:first')],
      [group('g1', ['git:first']), group('g2', ['git:second'])],
    );
    expect(result.panes.map(p => p.id)).toEqual([GIT_ID]);
    expect(result.panes[0]?.stableKey).toBe('git:first');
    expect(result.groups.map(g => g.paneIds)).toEqual([[GIT_ID]]);
  });

  test('pane order is left as it was, and other types are untouched', () => {
    const result = migrateProjectPaneIdentity(
      PROJECT,
      [pane('file:a', 'file'), pane('git:legacy'), pane('browser:ctx', 'browser')],
      [group('g1', ['browser:ctx', 'git:legacy', 'file:a'])],
    );
    expect(result.panes.map(p => p.id)).toEqual(['file:a', GIT_ID, 'browser:ctx']);
    expect(result.groups[0]?.paneIds).toEqual(['browser:ctx', GIT_ID, 'file:a']);
  });
});
