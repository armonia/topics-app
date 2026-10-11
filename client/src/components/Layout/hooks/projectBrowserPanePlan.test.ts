/**
 * @covers BROWSER-CHAT-04
 */
import { describe, expect, test } from 'bun:test';
import type { PaneGroup } from '../../../types';
import { resolveProjectBrowserTargetGroup } from './projectBrowserPanePlan';

const group = (id: string, paneIds: string[], activePaneId = paneIds[0]): PaneGroup => ({
  id,
  paneIds,
  activePaneId,
  type: 'chat',
});

describe('project browser placement', () => {
  test('targets the group that hosts the requesting chat before the focused group', () => {
    // Two chats of one project; focus is on the other chat's group, which is
    // where the page of the first one used to land.
    const groups = [group('g1', ['t-a']), group('g2', ['t-b', 'browser:t-b'])];
    expect(resolveProjectBrowserTargetGroup(groups, undefined, 'g2', 't-a')).toBe('g1');
  });

  test('focus is only the fallback, and an explicit target wins', () => {
    const groups = [group('g1', ['t-a']), group('g2', ['t-b'])];
    expect(resolveProjectBrowserTargetGroup(groups, undefined, 'g2', 'missing')).toBe('g2');
    expect(resolveProjectBrowserTargetGroup(groups, 'g1', 'g2', 't-b')).toBe('g1');
  });
});
