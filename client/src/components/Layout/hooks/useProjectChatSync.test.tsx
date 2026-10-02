/**
 * THE FIRST SYNC WAITS FOR THE TOPICS.
 *
 * The layout seed opens the chats of `openChatTopicIds` even when `topics`
 * does not know them yet (a topic cache emptied or written badly). The empty
 * topic list then raised the first-sync gate, and the baseline of "topics
 * already here" was taken EMPTY: when the topics arrived the delta branch saw
 * every one of them as new and opened them all as tabs, the ones the user had
 * closed included, and the saved active chat was never restored.
 *
 * Driven through the real hook with `reactHarness` (no DOM in this project).
 *
 * @covers LAYOUT-01
 */
import { describe, test, expect } from 'bun:test';
import { createElement } from 'react';
import { mount } from '../../../test/reactHarness';
import { useProjectChatSync } from './useProjectChatSync';
import type { ChatReconciliation } from './types';
import type { Pane, PaneGroup, Topic } from '../../../types';

const PROJECT = '/p/demo';

function topic(id: string, sortOrder: number): Topic {
  return {
    id, name: id, slug: id, parentId: null, links: [], sessionKey: id, color: '', icon: '',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    archived: false, projectPath: PROJECT, sortOrder,
  } as Topic;
}

describe('useProjectChatSync, topics that arrive after the layout', () => {
  test('restores the saved chats and opens none of the closed ones', () => {
    const chatA: Pane = { id: 'chat:A', type: 'chat', topicId: 'A', title: 'A', preview: false };
    const group: PaneGroup = { id: 'g1', type: 'chat', paneIds: [chatA.id], activePaneId: chatA.id } as PaneGroup;
    const applied: ChatReconciliation[] = [];
    let topics: Record<string, Topic> = {};
    const gateRefs = { initialChatsSyncedRef: { current: false } };

    function Probe() {
      useProjectChatSync({
        projectPath: PROJECT,
        topics,
        initial: { nonChatPanes: [], openChatTopicIds: ['A'], activeChatTopicId: 'A' },
        panes: [chatA],
        groups: [group],
        focusedGroupId: group.id,
        applyChatReconciliation: (r) => { applied.push(r); },
        reopenChatPane: () => {},
        gateRefs,
        markChatSyncDone: () => {},
      });
      return null;
    }

    const h = mount(createElement(Probe));
    try {
      // The topics land: A was open, B and C had been closed by the user.
      topics = { A: topic('A', 0), B: topic('B', 1), C: topic('C', 2) };
      h.rerender();
      const added = applied.flatMap(r => r.add.map(p => p.topicId));
      expect(added).not.toContain('B');
      expect(added).not.toContain('C');
      // The saved active chat is restored by the first sync proper.
      expect(applied.some(r => r.activateInGroup?.paneId === chatA.id)).toBe(true);
    } finally {
      h.unmount();
    }
  });

  test('a layout with no chat panes waits for the topics too, and opens none of them', () => {
    // The saved layout holds only a terminal; the topic cache was empty, so
    // the topics list is still pending. Nothing told the first sync to wait:
    // it took an EMPTY baseline and the delta branch then opened every
    // non-archived topic of the project as a tab when the list arrived.
    const term: Pane = { id: 'terminal:t1', type: 'terminal', title: 'zsh', preview: false } as Pane;
    const group: PaneGroup = { id: 'g1', type: 'utility', paneIds: [term.id], activePaneId: term.id } as PaneGroup;
    const applied: ChatReconciliation[] = [];
    let topics: Record<string, Topic> = {};
    let topicsPending = true;
    const gateRefs = { initialChatsSyncedRef: { current: false } };

    function Probe() {
      useProjectChatSync({
        projectPath: PROJECT,
        topics,
        topicsPending,
        initial: { nonChatPanes: [], openChatTopicIds: [], activeChatTopicId: undefined },
        panes: [term],
        groups: [group],
        focusedGroupId: group.id,
        applyChatReconciliation: (r) => { applied.push(r); },
        reopenChatPane: () => {},
        gateRefs,
        markChatSyncDone: () => {},
      });
      return null;
    }

    const h = mount(createElement(Probe));
    try {
      topics = { A: topic('A', 0), B: topic('B', 1) };
      topicsPending = false;
      h.rerender();
      expect(applied.flatMap(r => r.add.map(p => p.topicId))).toEqual([]);
      // Once the list is known a topic that genuinely arrives later still opens.
      topics = { ...topics, C: topic('C', 2) };
      h.rerender();
      expect(applied.flatMap(r => r.add.map(p => p.topicId))).toEqual(['C']);
    } finally {
      h.unmount();
    }
  });
});
