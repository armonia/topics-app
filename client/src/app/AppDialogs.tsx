import { Suspense, type ComponentProps, type Dispatch, type SetStateAction } from 'react';
import type { UsePanelLifecycleReturn } from '../hooks/usePanelLifecycle';
import type { useTopics } from '../hooks/useTopics';
import type { useChat } from '../hooks/useChat';
import type { useWebSocket } from '../hooks/useWebSocket';
import type { useTheme } from '../hooks/useTheme';
import type { useClosedTabs } from '../state/pane/adapters';
import { createPaneId } from '../state/pane/adapters';
import { popOutTopic } from '../lib/popOutTopic';
import { CommandPaletteHost, FileSearch, KeyboardShortcuts, NewTopicModal, TopicContextMenu } from './lazyHosts';

type PanelState = UsePanelLifecycleReturn['state'];
type PanelHandlers = UsePanelLifecycleReturn['handlers'];
type TopicsApi = ReturnType<typeof useTopics>;

interface AppDialogsProps {
  contextMenu: PanelState['contextMenu'];
  setContextMenu: PanelHandlers['setContextMenu'];
  updateTopic: TopicsApi['updateTopic'];
  archiveTopic: TopicsApi['archiveTopic'];
  pinnedIds: ReadonlySet<string>;
  unpinAlsoArchives: (id: string) => boolean;
  handleTogglePin: (id: string) => void;
  handleClosePanel: PanelHandlers['handleClosePanel'];
  stopSession: ReturnType<typeof useChat>['stopSession'];
  showNewTopic: false | { projectPath?: string; worktreeId?: string };
  setShowNewTopic: Dispatch<SetStateAction<false | { projectPath?: string; worktreeId?: string }>>;
  handleCreateTopic: PanelHandlers['handleCreateTopic'];
  onWSMessage: ReturnType<typeof useWebSocket>['onMessage'];
  showSearch: boolean;
  setShowSearch: Dispatch<SetStateAction<boolean>>;
  searchScope: 'all' | 'projects' | 'history';
  closePalette: () => void;
  topics: TopicsApi['topics'];
  workspaceProjects: TopicsApi['workspaceProjects'];
  openTopicFromSearch: (id: string) => void;
  handleProjectClick: PanelHandlers['handleProjectClick'];
  handleQuickCreateTopic: PanelHandlers['handleQuickCreateTopic'];
  handleStandaloneAddPane: ComponentProps<typeof CommandPaletteHost>['onAddPane'];
  handleOpenProjectPicker: () => Promise<void>;
  toggleTheme: ReturnType<typeof useTheme>['toggleTheme'];
  themeMode: ReturnType<typeof useTheme>['themeMode'];
  splitLayoutAvailable: boolean;
  searchProjectPaths: string[];
  showFileSearch: false | { projectPaths: string[]; mode: 'name' | 'content' };
  setShowFileSearch: Dispatch<SetStateAction<false | { projectPaths: string[]; mode: 'name' | 'content' }>>;
  focusedProjectPath: string | undefined;
  focusedPanelId: string | null;
  closedTabs: ReturnType<typeof useClosedTabs>['closedTabs'];
  handleReopenClosedTab: PanelHandlers['handleReopenClosedTab'];
  openHistoryUrl: (url: string) => void;
  showShortcuts: boolean;
  setShowShortcuts: Dispatch<SetStateAction<boolean>>;
}

/** The modal surfaces of the app root: topic context menu, new topic, palette, shortcuts, file search. */
export function AppDialogs({
  contextMenu, setContextMenu, updateTopic, archiveTopic, pinnedIds, unpinAlsoArchives,
  handleTogglePin, handleClosePanel, stopSession, showNewTopic, setShowNewTopic, handleCreateTopic,
  onWSMessage, showSearch, setShowSearch, searchScope, closePalette, topics, workspaceProjects,
  openTopicFromSearch, handleProjectClick, handleQuickCreateTopic, handleStandaloneAddPane,
  handleOpenProjectPicker, toggleTheme, themeMode, splitLayoutAvailable, searchProjectPaths,
  showFileSearch, setShowFileSearch, focusedProjectPath, focusedPanelId, closedTabs,
  handleReopenClosedTab, openHistoryUrl, showShortcuts, setShowShortcuts,
}: AppDialogsProps) {
  return (
    <>
      {/* The "New" sidebar header menu used to live here as a hand-rolled
          DropdownPortal + 4 hard-coded items. It now renders inline above
          via <PaneAddMenu scope="standalone" presentation="palette" /> (⌘N),
          so the trigger button AND the centered palette are the canonical
          components, no third menu implementation. */}

      {/* Context menu, keyed by topic so a right-click on a DIFFERENT topic
          remounts it: without the key, React reuses the instance and its local
          state (open subMenu, half-typed renameValue seeded in a useState
          initializer) survives the prop swap, Save/Delete would then act on
          the NEW topic with the OLD topic's state. */}
      {contextMenu && (
        <Suspense fallback={null}><TopicContextMenu
          key={contextMenu.topic.id}
          x={contextMenu.x}
          y={contextMenu.y}
          topic={contextMenu.topic}
          onClose={() => setContextMenu(null)}
          onUpdate={updateTopic}
          onDelete={archiveTopic}
          isPinned={pinnedIds.has(contextMenu.topic.id)}
          // Unpinning a chat you are not looking at ARCHIVES it, i.e. removes it
          // from the list: the label says so instead of letting it be
          // discovered afterwards.
          unpinAlsoArchives={unpinAlsoArchives(contextMenu.topic.id)}
          onTogglePin={() => handleTogglePin(contextMenu.topic.id)}
          onPopOut={() => {
            // Same contract as the pane-menu pop-out: drop the source pane only
            // when a window actually opened (popOutTopic returns false when it
            // just focused an existing window or the popup was blocked).
            void popOutTopic(contextMenu.topic.id).then((opened) => {
              if (opened) handleClosePanel(contextMenu.topic.id);
            });
          }}
          // The SAME command the composer and the row rail fire, not a third
          // path: the menu row exists because the rail does not reveal itself
          // to a finger (see `onStopStreaming` in ContextMenu).
          onStopStreaming={contextMenu.topic.isGlobalOrchestrator ? undefined : () => {
            void stopSession(contextMenu.topic.sessionKey);
          }}
        /></Suspense>
      )}

      {/* New topic modal */}
      {showNewTopic && (
        <Suspense fallback={null}>
          <NewTopicModal
            isOpen={!!showNewTopic}
            onClose={() => setShowNewTopic(false)}
            onCreate={handleCreateTopic}
            projectPath={showNewTopic ? showNewTopic.projectPath : undefined}
            worktreeId={showNewTopic ? showNewTopic.worktreeId : undefined}
            onMessage={onWSMessage}
          />
        </Suspense>
      )}

      {/* Command Palette (⌘K = everything, ⌘F = projects scope). */}
      {showSearch && (
          <CommandPaletteHost
            isOpen={showSearch}
            scope={searchScope}
            onClose={closePalette}
            topics={topics}
            workspaceProjects={workspaceProjects}
            onOpenTopic={openTopicFromSearch}
            onOpenProject={handleProjectClick}
            onNewTopic={handleQuickCreateTopic}
            onAddPane={handleStandaloneAddPane}
            onProjectPicker={handleOpenProjectPicker}
            onToggleTheme={toggleTheme}
            // "Reset panels" (collapse to one tabbed cell) + "Auto-tile"
            // (auto-tile into a balanced grid), per-window
            // CustomEvent bus (same pattern as topics:open-project-picker); the
            // standalone PanelGrid listener performs each.
            //
            // `undefined` under 768px, which in the palette is already the way
            // an entry does NOT exist (see `if (onResetPanels)` in there): same
            // rule as the ⋯ menu above, applied to the same pair of
            // commands from a single source of truth.
            onResetPanels={splitLayoutAvailable ? () => window.dispatchEvent(new CustomEvent('topics:reset-split-layout')) : undefined}
            onAutoTilePanels={splitLayoutAvailable ? () => window.dispatchEvent(new CustomEvent('topics:auto-tile-layout')) : undefined}
            onOpenFileSearch={() => {
              setShowSearch(false);
              // Same scope as ⌘F: the focused project plus the open ones.
              if (searchProjectPaths.length > 0) setShowFileSearch({ projectPaths: searchProjectPaths, mode: 'content' });
            }}
            themeMode={themeMode}
            projectPath={focusedProjectPath}
            onOpenFile={(path) => {
              // Target the searched project's WINDOW explicitly (not just the
              // focused panel id) so the file opens ONLY in that project window,
              // never in every project open in split view.
              const topicId = focusedProjectPath ? createPaneId('project', focusedProjectPath) : focusedPanelId;
              window.dispatchEvent(new CustomEvent('open-file', { detail: { path, topicId } }));
              setShowSearch(false);
            }}
            closedTabs={closedTabs}
            onReopenClosedTab={handleReopenClosedTab}
            onOpenHistoryUrl={openHistoryUrl}
          />
      )}

      {/* Keyboard Shortcuts (⌘?) */}
      {showShortcuts && (
        <Suspense fallback={null}>
          <KeyboardShortcuts
            isOpen={showShortcuts}
            onClose={() => setShowShortcuts(false)}
          />
        </Suspense>
      )}

      {showFileSearch !== false && (
        <Suspense fallback={null}>
          <FileSearch
            projectPaths={showFileSearch.projectPaths}
            mode={showFileSearch.mode}
            onModeChange={(mode) => setShowFileSearch((prev) => (prev ? { ...prev, mode } : prev))}
            onOpenFile={(path, lineNumber) => {
              // The file opens in the window of the project THAT CONTAINS IT, not
              // in the focused one: since the search became multi-project the two
              // can differ, and opening it in the wrong window means showing you
              // the right file in the wrong place.
              const owner = showFileSearch.projectPaths.find((root) => path.startsWith(root + '/'))
                ?? showFileSearch.projectPaths[0];
              window.dispatchEvent(new CustomEvent('open-file', {
                detail: { path, lineNumber, topicId: createPaneId('project', owner) },
              }));
            }}
            onClose={() => setShowFileSearch(false)}
          />
        </Suspense>
      )}
    </>
  );
}
