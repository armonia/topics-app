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

export interface UseKeyboardShortcutsArgs {
  isElectron: boolean;
  // Snapshots — mirrored into refs so the handler reads fresh state
  // without re-registering on every change.
  focusedPanelId: string | null;
  openPanels: string[];
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

export function useKeyboardShortcuts(args: UseKeyboardShortcutsArgs): void {
  // ---- Mirror snapshots into refs (no-deps useEffects = every render) ----
  const focusedPanelIdRef = useRef(args.focusedPanelId);
  const openPanelsRef = useRef(args.openPanels);
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

      if (isElectron && isMod && e.key === 'n') {
        e.preventDefault();
        if (e.shiftKey) {
          setShowNewTopic({});
        } else {
          handleQuickCreateTopic();
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
        if (fp) handleClosePanel(fp);
        return;
      }

      if (isElectron && isMod && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        const panels = openPanelsRef.current;
        if (idx < panels.length) setFocusedPanelId(panels[idx]);
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

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
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
