/**
 * Which panes of a project window are written to the server so the reload
 * restores the same arrangement — and which ones (chat tabs, the wrapper
 * pane, a preview nobody is looking at) deliberately are not.
 *
 * @covers LAYOUT-02
 */
import { describe, expect, test } from 'bun:test';
import {
  forgetProjectPersistence,
  layoutStorageKey,
  loadPersistedState,
  rememberSessionOnlyPanes,
  savePersistedLayoutState,
  savePersistedTabState,
  selectNonChatPanesToPersist,
  storageKey,
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

// Archiving a project removes its snapshot so that un-archiving starts from a
// clean layout (usePanelLifecycle, handleArchiveProject). The page memory above
// is part of that state: left behind, a project archived, restored and reopened
// in the same page brought back the background preview it had before.
describe('forgetProjectPersistence (archive)', () => {
  const ARCHIVED = '/tmp/archived-proj';

  /** In-memory localStorage, removed afterwards: see the shim note in
   *  `usePanelGridPersistence.test.ts` (putting back `undefined` is a leak). */
  const withStorage = (fn: (store: Map<string, string>) => void) => {
    const store = new Map<string, string>();
    const had = 'localStorage' in globalThis;
    const prev = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    };
    try {
      fn(store);
    } finally {
      if (had) (globalThis as { localStorage?: unknown }).localStorage = prev;
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  };

  test('an archived project mounts from nothing: no snapshot and no session-only pane', () => {
    withStorage((store) => {
      const term = pane('terminal:1', 'terminal', false);
      const git = pane('git:1', 'git', true);
      const groups = [group('g1', ['terminal:1', 'git:1'], 'terminal:1')];
      const persisted = selectNonChatPanesToPersist([term, git], groups, ARCHIVED);
      store.set(storageKey(ARCHIVED), JSON.stringify({ nonChatPanes: persisted }));
      store.set(layoutStorageKey(ARCHIVED), JSON.stringify({ sidebarCollapsed: true }));
      rememberSessionOnlyPanes(ARCHIVED, [term, git], persisted);
      expect(loadPersistedState(ARCHIVED)?.nonChatPanes.map(p => p.id)).toEqual(['terminal:1', 'git:1']);

      forgetProjectPersistence(ARCHIVED);

      expect(store.has(storageKey(ARCHIVED))).toBe(false);
      expect(store.has(layoutStorageKey(ARCHIVED))).toBe(false);
      expect(loadPersistedState(ARCHIVED)).toBeNull();
    });
  });

  // The archived window is still mounted when the forget runs, and its save
  // effect runs again in the next commits (measured in WebKit: forget, then a
  // remember 1 ms later with the Git preview). Those saves must not bring the
  // project back; the next mount of the window lifts the refusal.
  test('the saves of the window still mounted after the forget write nothing', () => {
    withStorage((store) => {
      const browser = pane('browser:1', 'browser', false);
      const git = pane('git:1', 'git', true);
      const groups = [group('g1', ['browser:1', 'git:1'], 'browser:1')];
      const persisted = selectNonChatPanesToPersist([browser, git], groups, ARCHIVED);
      rememberSessionOnlyPanes(ARCHIVED, [browser, git], persisted);

      forgetProjectPersistence(ARCHIVED);
      // One more run of useProjectPersistenceSave, same order as the effect.
      rememberSessionOnlyPanes(ARCHIVED, [browser, git], persisted);
      savePersistedTabState(ARCHIVED, { nonChatPanes: persisted, openChatTopicIds: [] });
      savePersistedLayoutState(ARCHIVED, { groups, sidebarCollapsed: false });

      expect(store.has(storageKey(ARCHIVED))).toBe(false);
      expect(store.has(layoutStorageKey(ARCHIVED))).toBe(false);
      // The reopen mounts from nothing.
      expect(loadPersistedState(ARCHIVED)).toBeNull();

      // Mounted again, the window saves as before.
      rememberSessionOnlyPanes(ARCHIVED, [browser, git], persisted);
      savePersistedLayoutState(ARCHIVED, { sidebarCollapsed: true });
      expect(withSessionOnlyPanes(ARCHIVED, []).map(p => p.id)).toEqual(['git:1']);
      expect(store.has(layoutStorageKey(ARCHIVED))).toBe(true);
      rememberSessionOnlyPanes(ARCHIVED, [], []);
    });
  });

  test('only the archived project is forgotten', () => {
    withStorage(() => {
      const git = pane('git:1', 'git', true);
      rememberSessionOnlyPanes(ARCHIVED, [git], []);
      rememberSessionOnlyPanes(PROJECT, [git], []);
      forgetProjectPersistence(ARCHIVED);
      expect(withSessionOnlyPanes(ARCHIVED, []).map(p => p.id)).toEqual([]);
      expect(withSessionOnlyPanes(PROJECT, []).map(p => p.id)).toEqual(['git:1']);
      rememberSessionOnlyPanes(PROJECT, [], []);
    });
  });
});
