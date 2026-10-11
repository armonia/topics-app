import { describe, expect, test } from 'bun:test';
import type { PaneGroup } from '../../../types';
import { activateBrowserPaneInGroup, resolveProjectBrowserTargetGroup } from './projectBrowserPanePlan';

const group = (id: string, paneIds: string[], activePaneId = paneIds[0]): PaneGroup => ({
  id,
  paneIds,
  activePaneId,
  type: 'chat',
});

describe('project browser placement', () => {
  test('targets the group that hosts the requesting chat before the focused group', () => {
    const groups = [group('chat-a', ['chat:a']), group('chat-b', ['chat:b'])];

    expect(resolveProjectBrowserTargetGroup(groups, undefined, 'chat-b', 'a')).toBe('chat-a');
  });

  test('moves and activates only the matching reused browser pane', () => {
    const groups = [
      group('chat-a', ['chat:a']),
      group('chat-b', ['chat:b']),
      group('browser-a', ['browser:ctx-a']),
      group('browser-b', ['browser:ctx-b']),
    ];

    const target = resolveProjectBrowserTargetGroup(groups, undefined, 'chat-b', 'a');
    const updated = activateBrowserPaneInGroup(groups, 'browser:ctx-a', target!);

    expect(updated.find(g => g.id === 'chat-a')).toMatchObject({
      paneIds: ['chat:a', 'browser:ctx-a'],
      activePaneId: 'browser:ctx-a',
    });
    expect(updated.find(g => g.id === 'browser-a')).toBeUndefined();
    expect(updated.find(g => g.id === 'browser-b')?.paneIds).toEqual(['browser:ctx-b']);
  });
});
