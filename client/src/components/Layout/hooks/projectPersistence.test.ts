/**
 * Which panes of a project window are written to the server so the reload
 * restores the same arrangement — and which ones (chat tabs, the wrapper
 * pane, a preview nobody is looking at) deliberately are not.
 *
 * @covers LAYOUT-02
 */
import { describe, expect, test } from 'bun:test';
import {
  rememberSessionOnlyPanes,
  selectNonChatPanesToPersist,
  withSessionOnlyPanes,
} from './projectPersistence';
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

// A remount is not a reload: crossing the phone breakpoint remounts the project
// window, which seeds from the snapshot above — so the background preview the
// snapshot leaves out has to come back from the page-lifetime memory.
describe('rememberSessionOnlyPanes / withSessionOnlyPanes', () => {
  const OTHER = '/tmp/other-proj';

  test('a background preview left out of the snapshot comes back on the next mount', () => {
    const term = pane('terminal:1', 'terminal', false);
    const git = pane('git:1', 'git', true);
    const panes = [term, git];
    const groups = [group('g1', ['terminal:1', 'git:1'], 'terminal:1')];
    const persisted = selectNonChatPanesToPersist(panes, groups, PROJECT);
    expect(persisted.map(p => p.id)).toEqual(['terminal:1']);
    rememberSessionOnlyPanes(PROJECT, panes, persisted);
    expect(withSessionOnlyPanes(PROJECT, persisted).map(p => p.id)).toEqual(['terminal:1', 'git:1']);
    // Scoped to its project.
    expect(withSessionOnlyPanes(OTHER, []).map(p => p.id)).toEqual([]);
  });

  test('a pane closed since is forgotten, so a remount does not resurrect it', () => {
    const term = pane('terminal:1', 'terminal', false);
    const git = pane('git:1', 'git', true);
    const groups = [group('g1', ['terminal:1', 'git:1'], 'terminal:1')];
    rememberSessionOnlyPanes(PROJECT, [term, git], selectNonChatPanesToPersist([term, git], groups, PROJECT));
    // The next commit, after the Git tab was closed.
    const after = [term];
    rememberSessionOnlyPanes(PROJECT, after, selectNonChatPanesToPersist(after, [group('g1', ['terminal:1'], 'terminal:1')], PROJECT));
    expect(withSessionOnlyPanes(PROJECT, [term]).map(p => p.id)).toEqual(['terminal:1']);
  });

  test('chats, the wrapper pane and panes already in the snapshot are not duplicated', () => {
    const chat = { id: createPaneId('chat', 't1'), type: 'chat' as const, title: 'c', preview: false, topicId: 't1' };
    const wrapper = pane(createPaneId('project', PROJECT), 'project', false);
    const git = pane('git:1', 'git', true);
    const persisted = [git];
    rememberSessionOnlyPanes(PROJECT, [chat, wrapper, git], persisted);
    expect(withSessionOnlyPanes(PROJECT, persisted)).toBe(persisted);
  });
});
