/**
 * Which panes of a project window are written to the server so the reload
 * restores the same arrangement — and which ones (chat tabs, the wrapper
 * pane, a preview nobody is looking at) deliberately are not.
 *
 * @covers LAYOUT-02
 */
import { describe, expect, test } from 'bun:test';
import { selectNonChatPanesToPersist } from './projectPersistence';
import { createPaneId } from '../../../state/pane/adapters';
import type { Pane, PaneGroup } from '../../../types';

const PROJECT = '/tmp/proj';

const pane = (id: string, type: Pane['type'], preview: boolean): Pane => ({
  id,
  type,
  title: id,
  preview,
});

const group = (id: string, paneIds: string[], activePaneId: string): PaneGroup => ({
  id,
  paneIds,
  activePaneId,
  type: 'utility',
});

describe('selectNonChatPanesToPersist', () => {
  test('durable panes (terminal/browser) always persist, even when not active', () => {
    const panes = [pane('terminal:1', 'terminal', false), pane('browser:1', 'browser', false)];
    const groups = [group('g1', ['terminal:1', 'browser:1'], 'terminal:1')];
    const ids = selectNonChatPanesToPersist(panes, groups, PROJECT).map(p => p.id);
    expect(ids).toEqual(['terminal:1', 'browser:1']);
  });

  test('a preview pane that is a group ACTIVE tab is persisted (the reload-focus fix)', () => {
    // Regression: Git/Files/Board are born preview:true. Dropping the ACTIVE one
    // made the focused tab vanish on reload, its cell collapse, focus jump to a
    // chat. It must survive.
    const active = pane('files:1', 'files', true);
    const panes = [active];
    const groups = [group('g1', ['files:1'], 'files:1')];
    const ids = selectNonChatPanesToPersist(panes, groups, PROJECT).map(p => p.id);
    expect(ids).toEqual(['files:1']);
  });

  test('a solo split-cell preview pane survives (its lone pane IS the activePaneId)', () => {
    const chat = { id: createPaneId('chat', 't1'), type: 'chat' as const, title: 'c', preview: false, topicId: 't1' };
    const git = pane('git:1', 'git', true);
    const panes: Pane[] = [chat, git];
    const groups = [
      group('gChat', [chat.id], chat.id),
      group('gGit', ['git:1'], 'git:1'), // split-out cell → git is its active pane
    ];
    const ids = selectNonChatPanesToPersist(panes, groups, PROJECT).map(p => p.id);
    expect(ids).toEqual(['git:1']); // chat excluded (openChatTopicIds channel), git kept
  });

  test('a NON-active preview tab (not being looked at) is still dropped', () => {
    const activeTerm = pane('terminal:1', 'terminal', false);
    const bgPreview = pane('files:1', 'files', true); // a background preview tab
    const panes = [activeTerm, bgPreview];
    const groups = [group('g1', ['terminal:1', 'files:1'], 'terminal:1')]; // terminal is active
    const ids = selectNonChatPanesToPersist(panes, groups, PROJECT).map(p => p.id);
    expect(ids).toEqual(['terminal:1']); // background preview dropped
  });

  test('chat panes never enter nonChatPanes (they ride openChatTopicIds)', () => {
    const chat = { id: createPaneId('chat', 't1'), type: 'chat' as const, title: 'c', preview: false, topicId: 't1' };
    const groups = [group('g1', [chat.id], chat.id)];
    expect(selectNonChatPanesToPersist([chat], groups, PROJECT)).toEqual([]);
  });

  test('the project wrapper pane is never persisted as its own child', () => {
    const wrapper = pane(createPaneId('project', PROJECT), 'project', false);
    const term = pane('terminal:1', 'terminal', false);
    const groups = [group('g1', ['terminal:1'], 'terminal:1')];
    const ids = selectNonChatPanesToPersist([wrapper, term], groups, PROJECT).map(p => p.id);
    expect(ids).toEqual(['terminal:1']);
  });
});
