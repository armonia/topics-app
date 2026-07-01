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
import { isDesktop, isTauri } from '../lib/shell';
import type { Topic } from '../types';
import { undo as undoUndo, redo as undoRedo, isTextInputFocused } from '../contexts/UndoContext';
import { isProjectPaneId, getProjectPathFromPaneId, type ClosedTabRecord } from '../state/pane/adapters';
import { OPEN_ADD_PALETTE_EVENT } from '../components/Shared/PaneAddMenu';

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
  /** Paid New Chat gate — when false, ⌘⇧N (New Topic modal) is inert (mirrored into a ref). */
  enableNewChat: boolean;
  // Stable callbacks (must not change identity each render).
  handleClosePanel: (topicId: string) => void;
  toggleSidebar: () => void;
  handleOpenAsPage: (type: 'activity' | 'agents' | 'dashboard' | 'cron') => void;
  setFocusedPanelId: (id: string) => void;
  /** Reopen a previously-closed tab (stable identity). */
  handleReopenClosedTab: (record: ClosedTabRecord) => void;
  /** Recently-closed tabs, newest first. Snapshot — mirrored into a ref. */
  closedTabs: ClosedTabRecord[];
  // Modal setters (React useState setters — stable identity).
  setShowSearch: Dispatch<SetStateAction<boolean>>;
  /** Palette scope — ⌘K opens 'all', ⌘F opens 'projects' (jump to project). */
  setSearchScope: Dispatch<SetStateAction<'all' | 'projects'>>;
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
  const enableNewChatRef = useRef(args.enableNewChat);
  const closedTabsRef = useRef(args.closedTabs);
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
  useEffect(() => { enableNewChatRef.current = args.enableNewChat; });
  useEffect(() => { closedTabsRef.current = args.closedTabs; });
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
    handleClosePanel, toggleSidebar,
    setFocusedPanelId, handleReopenClosedTab,
    setShowSearch, setSearchScope, setShowNewTopic, setShowShortcuts, setShowFileSearch,
  } = args;

  useEffect(() => {
    // File quick-open — shared by ⌘P (VS Code muscle memory) and ⌘⇧F (legacy
    // binding, kept working). Scoped to the focused project, falling back to
    // the first known project path.
    const toggleFileSearch = () => {
      const focusedProjectPath = focusedProjectPathRef.current;
      const topics = topicsRef.current;
      setShowFileSearch(prev => {
        if (prev) return false;
        if (focusedProjectPath) return { projectPath: focusedProjectPath };
        const projectPaths = [...new Set(Object.values(topics).map(t => t.projectPath).filter(Boolean))] as string[];
        if (projectPaths.length >= 1) return { projectPath: projectPaths[0] };
        return false;
      });
    };

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

      // ⌘K — command palette (everything: topics, messages, files, actions).
      // Deliberately NOT gated on text-input focus: the palette is reachable
      // from anywhere, including a focused terminal (matches the old behavior).
      if (isMod && e.key === 'k') {
        e.preventDefault();
        setSearchScope('all');
        setShowSearch(prev => !prev);
        return;
      }

      // ⌘N — the centered "New…" add palette (the sidebar header's "+").
      // Event-based so the palette state stays inside <PaneAddMenu> — same
      // pattern as topics:open-project-picker. (Moved off ⌘J: ⌘N is the
      // natural "new" key; Electron's default new-window is suppressed by
      // the preventDefault. In a plain browser tab the browser owns ⌘N —
      // Electron is the primary target.) ⌘⇧N keeps the New Topic modal,
      // gated on the paid New Chat feature like every chat-creation entry.
      if (isMod && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        if (e.shiftKey) {
          if (enableNewChatRef.current) setShowNewTopic({});
          return;
        }
        window.dispatchEvent(new CustomEvent(OPEN_ADD_PALETTE_EVENT));
        return;
      }

      // ⌘P — FILE quick-open scoped to the focused project (VS Code muscle
      // memory). Was a redundant alias of ⌘K; now it's the file finder.
      // Always preventDefault so the browser print dialog never opens.
      if (isMod && e.key === 'p') {
        e.preventDefault();
        toggleFileSearch();
        return;
      }

      // ⌘⇧F — same file quick-open (the original binding, kept working).
      if (isMod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        toggleFileSearch();
        return;
      }

      // ⌘F — command palette pre-scoped to PROJECTS (find/jump to a project).
      // CRITICAL: never hijack find/typing in a focused text input, the
      // terminal (xterm's helper textarea), or an editor — bail WITHOUT
      // preventDefault so the focused surface keeps its own ⌘F.
      if (isMod && !e.shiftKey && e.key === 'f') {
        if (isTextInputFocused(e.target)) return;
        e.preventDefault();
        setSearchScope('projects');
        setShowSearch(prev => !prev);
        return;
      }

      if (isMod && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // ⇧⌘T (primary) / ⌘⇧U (legacy alias) → reopen the most recently closed
      // tab. The target is resolved synchronously from the in-memory
      // recently-closed stack (`closedTabs[0]`), so reopen is instant for chats
      // (Warp / VS Code parity — both also bind ⇧⌘T to "reopen closed tab").
      // topics-app's primary surface is the Electron desktop app, where ⇧⌘T is
      // free: a packaged BrowserWindow has no browser tabs to "reopen", so
      // there is nothing to contend with. In a plain dev-browser tab the
      // preventDefault below overrides Chrome's reopen-tab while the app is
      // focused, which is the intended in-app behavior. The Electron app ALSO
      // claims ⇧⌘T as a native menu accelerator → `reopen-closed-tab` IPC (see
      // electron-app/main.ts + App.tsx) so the chord still fires when focus is
      // inside a native pane that swallows the renderer keydown.
      if (
        isMod && e.shiftKey &&
        (e.key === 't' || e.key === 'T' || e.key === 'u' || e.key === 'U')
      ) {
        e.preventDefault();
        // In Electron, ⇧⌘T is ALSO a native menu accelerator (electron-app/main.ts)
        // that runs this very reopen via IPC — and it fires even when focus is
        // inside a native pane that swallows the renderer keydown. Handling ⇧⌘T
        // here too reopened the tab TWICE per press, so let the menu own it. ⇧⌘U
        // has no accelerator, so its renderer keydown stays the sole trigger on
        // every platform. (preventDefault already ran above to swallow Chrome's
        // own reopen-closed-tab in a plain dev-browser tab.)
        if (isElectron && (e.key === 't' || e.key === 'T')) return;
        const last = closedTabsRef.current[0];
        if (last) handleReopenClosedTab(last);
        return;
      }

      // Tauri only: ⌘R / ⌘⇧R reload the app. The native View ▸ Reload menu item
      // exists (lib.rs) but its key equivalent is swallowed by the focused
      // WKWebView before the menu sees it, so the accelerator never fires — we
      // intercept it here in the renderer (which DOES receive the keydown) and
      // reload directly. Electron's native menu reload works, and the web build
      // wants the browser's own reload, so this is gated to Tauri.
      if (isTauri && isMod && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        window.location.reload();
        return;
      }

      // Desktop (Electron + Tauri): ⌘W closes the focused PANE, not the window.
      // Under Tauri the native menu's close_window accelerator is removed (lib.rs)
      // so this is the sole ⌘W handler; it reaches the focused pane whenever focus
      // is in the main webview (a child browser webview that has focus swallows
      // the keydown — that edge gets a menu accelerator in the browser-pane phase).
      if (isDesktop && isMod && e.key === 'w') {
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

      // Tab cycling (standard): ⌃Tab → next tab, ⌃⇧Tab → previous, and ⌘⇧Tab
      // → previous (⌘Tab is reserved by macOS for app-switching, so the ⌘ pair
      // only does previous). Cycles the TOP-LEVEL panels relative to the focused
      // one, wrapping. When focus is inside a native browser pane this keydown is
      // swallowed by the OS view — the native key-forwarder (Electron before-
      // input-event / Tauri NSEvent monitor) re-dispatches it so it still fires.
      if (e.key === 'Tab' && (e.ctrlKey || (e.metaKey && e.shiftKey))) {
        e.preventDefault();
        const panels = openPanelsRef.current;
        if (panels.length >= 2) {
          const cur = focusedPanelIdRef.current;
          const idx = cur ? panels.indexOf(cur) : -1;
          const dir = e.shiftKey ? -1 : 1; // ⇧ → previous, else next
          const base = idx < 0 ? 0 : idx;
          const nextId = panels[(base + dir + panels.length) % panels.length];
          setFocusedPanelId(nextId);
        }
        return;
      }

      if (isDesktop && isMod && e.key >= '1' && e.key <= '9') {
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
    toggleSidebar,
    handleReopenClosedTab,
    setShowSearch,
    setSearchScope,
    setShowNewTopic,
    setShowShortcuts,
    setShowFileSearch,
    setFocusedPanelId,
  ]);

}
