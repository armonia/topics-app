/**
 * useKeyboardShortcuts — App-wide keyboard handler with the ref-mirror
 * pattern (CRITIQUE C2 fix).
 *
 * Today's keyboard listener re-mounts on every panel focus / topic
 * load / modal toggle because the effect deps include focusedPanelId,
 * openPanels, topics, and four modal flags — each of which changes
 * independently of the handler's actual identity.
 *
 * The fix is NOT just file extraction. The real fix is: mirror every
 * read-on-event-only value (focused pane, open panels, topics list,
 * focused project path, four modal snapshots) into refs via no-deps
 * useEffects, then read them via `.current` inside the handler. The
 * keydown listener then registers ONCE on mount with deps containing
 * only stable callbacks — no churn on focus/open changes.
 *
 * Also owns the `open-all-boards` custom event listener.
 */

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Topic } from '../types';
import { undo as undoUndo, redo as undoRedo, isTextInputFocused } from '../contexts/UndoContext';
import { isProjectPaneId, getProjectPathFromPaneId } from '../state/pane/adapters';

export interface UseKeyboardShortcutsArgs {
  isElectron: boolean;
  // Snapshots — mirrored into refs so the handler reads fresh state
  // without re-registering on every change.
  focusedPanelId: string | null;
  openPanels: string[];
  /** paneIds open inside each project window, keyed by projectPath. Used to
   *  flatten Cmd+1-9 across both top-level panels and project sub-panes. */
  projectOpenPanes: Record<string, string[]>;
  topics: Record<string, Topic>;
  focusedProjectPath: string | undefined;
  showSearch: boolean;
  showNewTopic: false | { projectPath?: string };
  showShortcuts: boolean;
  showFileSearch: false | { projectPath: string };
  // Stable callbacks (must not change identity each render).
  handleClosePanel: (topicId: string) => void;
  handleQuickCreateTopic: (projectPath?: string) => Promise<unknown>;
  toggleSidebar: () => void;
  handleOpenAsPage: (type: 'activity' | 'agents' | 'dashboard' | 'all-boards' | 'cron') => void;
  setFocusedPanelId: (id: string) => void;
  // Modal setters (React useState setters — stable identity).
  setShowSearch: Dispatch<SetStateAction<boolean>>;
  setShowNewTopic: Dispatch<SetStateAction<false | { projectPath?: string }>>;
  setShowShortcuts: Dispatch<SetStateAction<boolean>>;
  setShowFileSearch: Dispatch<SetStateAction<false | { projectPath: string }>>;
}

/**
 * Build the flat ordered tab list used by Cmd+1-9. Each entry maps a global
 * index → either a top-level panel (no innerPaneId) or one project sub-pane
 * (panelId is the project's panelId, innerPaneId is the sub-pane).
 *
 * Top-level non-project panels contribute one slot each; project panels
 * contribute one slot per inner pane in the order reported by the project's
 * persistence layer. When projectOpenPanes is missing for a project (e.g.
 * the project hasn't mounted yet), we fall back to a single slot for the
 * project panel so Cmd+N at minimum still focuses it.
 */
function buildGlobalTabList(
  openPanels: string[],
  projectOpenPanes: Record<string, string[]>,
): Array<{ panelId: string; innerPaneId?: string }> {
  const list: Array<{ panelId: string; innerPaneId?: string }> = [];
  for (const panelId of openPanels) {
    if (isProjectPaneId(panelId)) {
      const projectPath = getProjectPathFromPaneId(panelId);
      const innerPanes = projectPath ? projectOpenPanes[projectPath] : undefined;
      if (innerPanes && innerPanes.length > 0) {
        for (const innerPaneId of innerPanes) {
          list.push({ panelId, innerPaneId });
        }
      } else {
        list.push({ panelId });
      }
    } else {
      list.push({ panelId });
    }
  }
  return list;
}

export function useKeyboardShortcuts(args: UseKeyboardShortcutsArgs): void {
  // ---- Mirror snapshots into refs (no-deps useEffects = every render) ----
  const focusedPanelIdRef = useRef(args.focusedPanelId);
  const openPanelsRef = useRef(args.openPanels);
  const projectOpenPanesRef = useRef(args.projectOpenPanes);
  const topicsRef = useRef(args.topics);
  const focusedProjectPathRef = useRef(args.focusedProjectPath);
  const modalsRef = useRef({
    showSearch: args.showSearch,
    showNewTopic: args.showNewTopic,
    showShortcuts: args.showShortcuts,
    showFileSearch: args.showFileSearch,
  });
  useEffect(() => { focusedPanelIdRef.current = args.focusedPanelId; });
  useEffect(() => { openPanelsRef.current = args.openPanels; });
  useEffect(() => { projectOpenPanesRef.current = args.projectOpenPanes; });
  useEffect(() => { topicsRef.current = args.topics; });
  useEffect(() => { focusedProjectPathRef.current = args.focusedProjectPath; });
  useEffect(() => {
    modalsRef.current = {
      showSearch: args.showSearch,
      showNewTopic: args.showNewTopic,
      showShortcuts: args.showShortcuts,
      showFileSearch: args.showFileSearch,
    };
  });

  // ---- Keyboard listener — registered ONCE on mount (modulo stable callback identity) ----
  const {
    isElectron,
    handleClosePanel, handleQuickCreateTopic, toggleSidebar, handleOpenAsPage,
    setFocusedPanelId,
    setShowSearch, setShowNewTopic, setShowShortcuts, setShowFileSearch,
  } = args;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd+Z / Cmd+Shift+Z — UI undo/redo
      if (isMod && (e.key === 'z' || e.key === 'Z')) {
        if (!isTextInputFocused(e.target)) {
          e.preventDefault();
          if (e.shiftKey) {
            undoRedo();
          } else {
            undoUndo();
          }
          return;
        }
      }

      if (isMod && e.key === 'k') {
        e.preventDefault();
        setShowSearch(prev => !prev);
        return;
      }

      // Cmd+Shift+M — jump to the open Master pane (if any). Quick
      // back-out from a session the user reached via the Master strip.
      // (Plain Cmd+M is reserved by macOS for "Minimize Window".)
      if (isMod && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
        if (isTextInputFocused(e.target)) return;
        const master = Object.values(topicsRef.current).find(
          (t) => !t.archived && t.agentTeamRole === 'lead',
        );
        if (master) {
          e.preventDefault();
          setFocusedPanelId(master.id);
          return;
        }
      }

      if (isElectron && isMod && e.key === 'n') {
        e.preventDefault();
        if (e.shiftKey) {
          setShowNewTopic({});
        } else {
          // Scope the new chat to the focused project so cmd+N inside a
          // ProjectWindow lands as a chat pane inside that project (which
          // also triggers `pendingFocusTopicId` → `reopenChatPane` in
          // useProjectLayout so the new pane is placed in the focused
          // group and focused). Without this, cmd+N from inside a project
          // created a top-level standalone draft and the focus snapped
          // back to the previously-active pane.
          handleQuickCreateTopic(focusedProjectPathRef.current);
        }
        return;
      }

      if (isMod && e.key === 'p') {
        e.preventDefault();
        setShowSearch(prev => !prev);
        return;
      }

      if (isMod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        const focusedProjectPath = focusedProjectPathRef.current;
        const topics = topicsRef.current;
        setShowFileSearch(prev => {
          if (prev) return false;
          if (focusedProjectPath) return { projectPath: focusedProjectPath };
          const projectPaths = [...new Set(Object.values(topics).map(t => t.projectPath).filter(Boolean))] as string[];
          if (projectPaths.length >= 1) return { projectPath: projectPaths[0] };
          return false;
        });
        return;
      }

      if (isMod && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      if (isMod && e.shiftKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('reopen-closed-tab'));
        return;
      }

      if (isElectron && isMod && e.key === 'w') {
        e.preventDefault();
        const fp = focusedPanelIdRef.current;
        if (!fp) return;
        // Give nested handlers (e.g. a focused project's GroupLayout)
        // first refusal — they close their inner active sub-tab and
        // mark the event handled. If nobody handles, fall back to
        // closing the App-level panel.
        const evt = new CustomEvent('close-focused-pane', {
          cancelable: true,
          detail: { panelId: fp },
        });
        window.dispatchEvent(evt);
        if (evt.defaultPrevented) return;
        handleClosePanel(fp);
        return;
      }

      if (isElectron && isMod && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        const panels = openPanelsRef.current;
        const projectPanes = projectOpenPanesRef.current;
        const flat = buildGlobalTabList(panels, projectPanes);
        if (idx >= flat.length) return; // let lower handlers see it (no global slot)
        e.preventDefault();
        // capture phase + stopImmediatePropagation suppresses the legacy
        // PaneTabBar local handler (also bound on window in capture phase),
        // so the inner project's Cmd+N never races with the global mapping.
        e.stopImmediatePropagation();
        const target = flat[idx];
        setFocusedPanelId(target.panelId);
        if (target.innerPaneId) {
          // Hop into the project window's inner pane. ProjectWindow listens
          // for this event and calls its `handleActivatePane` once the
          // panel becomes the focused one.
          const projectPath = getProjectPathFromPaneId(target.panelId);
          window.dispatchEvent(new CustomEvent('global-tab:focus-inner', {
            detail: { projectPath, paneId: target.innerPaneId },
          }));
        }
        return;
      }

      if (isMod && (e.key === '?' || e.key === '/')) {
        e.preventDefault();
        setShowShortcuts(prev => !prev);
        return;
      }

      if (e.key === 'Escape') {
        const m = modalsRef.current;
        if (m.showFileSearch !== false) { setShowFileSearch(false); e.preventDefault(); return; }
        if (m.showShortcuts) { setShowShortcuts(false); e.preventDefault(); return; }
        if (m.showSearch) { setShowSearch(false); e.preventDefault(); return; }
        if (m.showNewTopic) { setShowNewTopic(false); e.preventDefault(); return; }
      }
    };

    // Capture phase: fires before the per-PaneTabBar Cmd+1-9 handlers, so the
    // global tab list owns the mapping when it has a slot to claim.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [
    isElectron,
    handleClosePanel,
    handleQuickCreateTopic,
    toggleSidebar,
    setShowSearch,
    setShowNewTopic,
    setShowShortcuts,
    setShowFileSearch,
    setFocusedPanelId,
  ]);

  // ---- open-all-boards custom event ----
  useEffect(() => {
    const handler = () => handleOpenAsPage('all-boards');
    window.addEventListener('open-all-boards', handler);
    return () => window.removeEventListener('open-all-boards', handler);
  }, [handleOpenAsPage]);
}
