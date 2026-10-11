/**
 * @covers BROWSER-CHAT-04
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../../../test/reactHarness';
import type { Pane, PaneGroup, Topic, WSMessage } from '../../../types';
import { registerTopicWindowDoor, type TopicWindowSheet } from '../../../lib/topicWindowDoor';
import { useProjectBrowserPanes, type UseProjectBrowserPanesArgs } from './useProjectBrowserPanes';
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

  test('an agent page is claimed by the topic window before the project creates a browser pane', () => {
    const topicId = 'topic-a';
    const projectPath = '/p/demo';
    const chat: Pane = { id: 'chat:topic-a', type: 'chat', topicId, title: 'A', preview: false } as Pane;
    const panesRef = { current: [chat] } as UseProjectBrowserPanesArgs['panesRef'];
    const groupsRef = { current: [group('g1', [chat.id])] } as UseProjectBrowserPanesArgs['groupsRef'];
    const added: string[] = [];
    const opened: TopicWindowSheet[] = [];
    const navigated: { url: string; paneId?: string }[] = [];
    const handlers: ((msg: WSMessage) => void)[] = [];
    const stopDoor = registerTopicWindowDoor(topicId, sheet => { opened.push(sheet); return true; });
    const args: UseProjectBrowserPanesArgs = {
      projectPath,
      topics: { [topicId]: { id: topicId, projectPath } as Topic },
      panes: panesRef.current,
      groups: groupsRef.current,
      panesRef,
      groupsRef,
      focusedGroupIdRef: { current: 'g1' },
      setGroups: (() => {}) as UseProjectBrowserPanesArgs['setGroups'],
      setFocusedGroupId: (() => {}) as UseProjectBrowserPanesArgs['setFocusedGroupId'],
      onWSMessage: handler => { handlers.push(handler); return () => {}; },
      onBrowserNavigateUrl: (url, paneId) => { navigated.push({ url, paneId }); },
      handleAddPaneToGroupRef: { current: async (_groupId, _type, _subType, paneKey) => {
        const id = `browser:${paneKey}`;
        added.push(id);
        return id;
      } },
      handleAddPaneWhenEmptyRef: { current: null },
      handleSplitGroupRef: { current: null },
      handleClosePaneRef: { current: null },
      updatePaneRef: { current: null },
    };

    const previousWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      innerWidth: 1280,
      location: { hostname: 'localhost' },
      addEventListener() {},
      removeEventListener() {},
    };
    function Probe() {
      useProjectBrowserPanes(args);
      return null;
    }

    const harness = mount(createElement(Probe));
    try {
      expect(handlers).toHaveLength(1);
      handlers[0]!({
        type: 'browser:navigate',
        topicId,
        contextId: topicId,
        url: 'https://example.test/agent',
      } as WSMessage);

      expect(opened).toEqual([{
        contextId: topicId,
        url: 'https://example.test/agent',
        openedBy: 'agent',
      }]);
      expect(added).toEqual([]);

      const browser: Pane = { id: `browser:${topicId}`, type: 'browser', title: 'Browser', preview: false } as Pane;
      panesRef.current = [chat, browser];
      groupsRef.current = [group('g1', [chat.id, browser.id])];
      handlers[0]!({
        type: 'browser:navigate',
        topicId,
        contextId: topicId,
        url: 'https://example.test/next',
      } as WSMessage);
      expect(opened).toHaveLength(1);
      expect(navigated).toEqual([{ url: 'https://example.test/next', paneId: browser.id }]);
      expect(added).toEqual([]);
    } finally {
      harness.unmount();
      stopDoor();
      if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = previousWindow;
    }
  });
});
