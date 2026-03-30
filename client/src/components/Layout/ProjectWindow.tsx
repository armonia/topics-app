import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PaneGroup, PaneGroupType, GroupLayoutRow } from '../../types';
import { ProjectHeader, getProjectName } from './ProjectHeader';
import { ProjectSidebar } from '../Project/ProjectSidebar';
import { GroupLayout } from './GroupLayout';
import { ChatPane } from '../Chat/ChatPane';
import { createPaneId, createGroupId, PANE_CONFIG, getTerminalSessionFromPaneId } from '../../lib/paneConfig';
import { DND_TYPES } from '../../lib/dndTypes';
import { findPreviewPane, replacePaneInGroup } from '../../lib/previewTabs';
import { saveProjectLayout, loadProjectLayout } from '../../lib/projectLayoutSync';
import { useMultiContextPercent } from '../../hooks/useContextInspector';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { ToastOutlet } from '../Shared/Toast';

const ContextInspector = lazy(() => import('../Context/ContextInspector').then(m => ({ default: m.ContextInspector })));
const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const SingleTerminalPane = lazy(() => import('../Terminal/SingleTerminalPane').then(m => ({ default: m.SingleTerminalPane })));
const FileExplorer = lazy(() => import('../Project/FileExplorer').then(m => ({ default: m.FileExplorer })));
const FilePane = lazy(() => import('../Editor/FilePane').then(m => ({ default: m.FilePane })));
const GitChanges = lazy(() => import('../Project/GitChanges').then(m => ({ default: m.GitChanges })));
const ActivityPane = lazy(() => import('../Sidebar/ActivityPane').then(m => ({ default: m.ActivityPane })));
const JournalPane = lazy(() => import('../Journal/JournalPane').then(m => ({ default: m.JournalPane })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const KanbanBoard = lazy(() => import('../Board/KanbanBoard').then(m => ({ default: m.KanbanBoard })));
const BoardMemoryPanel = lazy(() => import('../Board/BoardMemoryPanel').then(m => ({ default: m.BoardMemoryPanel })));
const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const ProcessLogPane = lazy(() => import('../Project/ProcessLogPane').then(m => ({ default: m.ProcessLogPane })));
const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;

// --- Persistence helpers ---

function storageKey(projectPath: string): string {
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = projectPath.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash;
  }
  return `topics-project-panes-${Math.abs(hash).toString(36)}`;
}

interface PersistedState {
  nonChatPanes: Pane[];
  groups?: PaneGroup[];
  rows?: GroupLayoutRow[];
  rowHeights?: number[];
  sidebarCollapsed: boolean;
  closedTopicIds?: string[];       // legacy — no longer written
  openChatTopicIds?: string[];     // topic IDs that were open when last saved
  activeChatTopicId?: string;      // which chat tab was active when last saved
}

function loadPersistedState(projectPath: string): PersistedState | null {
  return loadProjectLayout(storageKey(projectPath), projectPath);
}

function savePersistedState(projectPath: string, state: PersistedState) {
  saveProjectLayout(storageKey(projectPath), projectPath, state);
}

// Map PaneType → PaneGroupType
function paneTypeToGroupType(type: PaneType): PaneGroupType {
  if (type === 'chat') return 'chat';
  if (type === 'file' || type === 'files') return 'file';
  return 'utility';
}

// Build default groups from a flat list of panes (migration from old format)
// All panes go into a single group — only explicit user splits create additional groups.
function buildDefaultGroups(panes: Pane[]): { groups: PaneGroup[]; rows: GroupLayoutRow[] } {
  if (panes.length === 0) return { groups: [], rows: [] };

  const g: PaneGroup = {
    id: createGroupId(),
    paneIds: panes.map(p => p.id),
    activePaneId: panes[0].id,
    type: 'chat', // primary type; the group accepts any pane type
  };

  return {
    groups: [g],
    rows: [{ groupIds: [g.id], widths: [1] }],
  };
}

const LazySpinner = <div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" /></div>;

// --- ProjectWindowPane: self-contained project content (no header/chrome) ---

export interface ProjectWindowPaneProps {
  projectPath: string;
  topics: Record<string, Topic>;
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string) => void;
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  stopSession: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  pendingPane?: PaneType;
  pendingTerminalSessionId?: string;
  onPendingPaneConsumed?: () => void;
  onNewChat?: () => void;
  // Navigate to a specific topic inside the project (from external focus)
  pendingFocusTopicId?: string | null;
  onPendingFocusConsumed?: () => void;
  // Report which topic is currently active in this project window
  onActiveTopicChange?: (topicId: string | null) => void;
}

export function ProjectWindowPane({
  projectPath, topics, focusedPanelId,
  onFocusPanel, onClosePanel: _onClosePanel,
  getSessionMessages, isSessionLoading, isSessionStreaming, stopSession,
  sendMessage, editMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  pendingPane, pendingTerminalSessionId, onPendingPaneConsumed, onNewChat,
  pendingFocusTopicId, onPendingFocusConsumed,
  onActiveTopicChange,
}: ProjectWindowPaneProps) {
  // Compute topicIds from topics that belong to this project
  const topicIds = useMemo(() =>
    Object.values(topics)
      .filter(t => t.projectPath === projectPath && !t.archived)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt.localeCompare(b.createdAt))
      .map(t => t.id),
    [topics, projectPath]
  );

  // Load persisted state
  const persisted = useRef(loadPersistedState(projectPath));

  // Responsive: overlay context inspector when window is narrow
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 1024);
  useEffect(() => { const h = () => setIsNarrow(window.innerWidth < 1024); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  // --- Core state ---
  const [panes, setPanes] = useState<Pane[]>(() => persisted.current?.nonChatPanes || []);
  const [groups, setGroups] = useState<PaneGroup[]>(() =>
    (persisted.current?.groups || []).filter(g => g.paneIds.length > 0)
  );
  const pendingPreviewCloseRef = useRef<string | null>(null);
  const [rows, setRows] = useState<GroupLayoutRow[]>(() => persisted.current?.rows || []);
  const [rowHeights, setRowHeights] = useState<number[]>(() => persisted.current?.rowHeights || [1]);
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (window.innerWidth < 768) return true; // Always collapsed on mobile
    return persisted.current?.sidebarCollapsed ?? false;
  });
  const [showContext, setShowContext] = useState(() => {
    try { return localStorage.getItem('topics-context-inspector-open') === 'true'; } catch { return false; }
  });
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);
  const [claudeSkipPermissions] = useClaudeSkipPermissions();

  // Determine active topic for Context Inspector
  const focusedGroup = groups.find(g => g.id === focusedGroupId);
  const focusedPane = focusedGroup ? panes.find(p => p.id === focusedGroup.activePaneId) : null;
  const activeTopicId = focusedPane?.type === 'chat' ? focusedPane.topicId || null : null;
  const activeTopic = activeTopicId ? topics[activeTopicId] : null;

  // Report active topic changes to parent (for sidebar highlighting)
  useEffect(() => {
    onActiveTopicChange?.(activeTopicId);
  }, [activeTopicId, onActiveTopicChange]);

  const paneToTopicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of panes) {
      if (p.type === 'chat' && p.topicId) map[p.id] = p.topicId;
    }
    return map;
  }, [panes]);
  const contextPercent = useMultiContextPercent(paneToTopicMap, onWSMessage);

  const streamingPaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of panes) {
      if (p.type === 'chat' && p.topicId) {
        const topic = topics[p.topicId];
        if (topic && isSessionStreaming(topic.sessionKey)) {
          ids.add(p.id);
        }
      }
    }
    return ids;
  }, [panes, topics, isSessionStreaming]);

  const handleStopStreaming = useCallback((paneId: string) => {
    const pane = panes.find(p => p.id === paneId);
    if (pane?.topicId) {
      const topic = topics[pane.topicId];
      if (topic) {
        const isFirst = stopSession(topic.sessionKey);
        if (isFirst) {
          // First message stopped — close the tab locally
          setPanes(prev => prev.filter(p => p.id !== paneId));
        }
      }
    }
  }, [panes, topics, stopSession]);

  useEffect(() => {
    try { localStorage.setItem('topics-context-inspector-open', String(showContext)); } catch {}
  }, [showContext]);

  // Persist non-chat panes, groups, rows, and open chat topic IDs
  useEffect(() => {
    const nonChatPanes = panes.filter(p => p.type !== 'chat' && !p.preview);
    const nonChatGroups = groups.filter(g => g.type !== 'chat').map(g => ({
      ...g,
      paneIds: g.paneIds.filter(id => nonChatPanes.some(p => p.id === id)),
    })).filter(g => g.paneIds.length > 0);
    const openChatTopicIds = panes
      .filter(p => p.type === 'chat' && p.topicId)
      .map(p => p.topicId!);
    // Find the active chat topic ID from the focused chat group
    const chatGroup = groups.find(g => g.type === 'chat');
    const activeChatPane = chatGroup ? panes.find(p => p.id === chatGroup.activePaneId) : null;
    const activeChatTopicId = activeChatPane?.type === 'chat' ? activeChatPane.topicId : undefined;

    savePersistedState(projectPath, {
      nonChatPanes,
      groups: nonChatGroups,
      rows,
      rowHeights,
      sidebarCollapsed,
      openChatTopicIds,
      activeChatTopicId,
    });
  }, [panes, groups, rows, rowHeights, sidebarCollapsed, projectPath]);

  // Clean stale terminal panes when terminal sessions change (via WS broadcast)
  useEffect(() => {
    // Validate on mount: fetch current sessions and remove stale terminal panes
    fetch('/api/terminal/sessions').then(r => r.json()).then((sessions: { id: string }[]) => {
      const sessionIds = new Set(sessions.map(s => s.id));
      setPanes(prev => {
        const filtered = prev.filter(p => p.type !== 'terminal' || sessionIds.has(getTerminalSessionFromPaneId(p.id) || ''));
        return filtered.length === prev.length ? prev : filtered;
      });
    }).catch(() => {});

    // Listen for session updates
    return onWSMessage((msg: any) => {
      if (msg.type === 'terminal:sessions' && Array.isArray(msg.sessions)) {
        const sessionIds = new Set((msg.sessions as { id: string }[]).map(s => s.id));
        setPanes(prev => {
          const filtered = prev.filter(p => p.type !== 'terminal' || sessionIds.has(getTerminalSessionFromPaneId(p.id) || ''));
          return filtered.length === prev.length ? prev : filtered;
        });
      }
    });
  }, [onWSMessage]);

  // --- Sync chat panes with topicIds + title sync (consolidated) ---
  const initialChatsSyncedRef = useRef(false);
  useEffect(() => {
    const currentSet = new Set(topicIds);

    setPanes(prev => {
      let updated = prev;

      // Remove chat panes whose topic no longer exists in the project
      if (prev.some(p => p.type === 'chat' && !(p.topicId && currentSet.has(p.topicId)))) {
        updated = prev.filter(p => p.type !== 'chat' || (p.topicId && currentSet.has(p.topicId)));
      }

      // On first sync only: restore chats that were open last session
      if (!initialChatsSyncedRef.current) {
        initialChatsSyncedRef.current = true;
        const openSet = new Set(persisted.current?.openChatTopicIds || []);
        const isLegacy = !persisted.current?.openChatTopicIds && persisted.current?.closedTopicIds;
        const closedSet = new Set(persisted.current?.closedTopicIds || []);
        const chatPaneIds = new Set(updated.filter(p => p.type === 'chat').map(p => p.topicId));
        const newChatPanes: Pane[] = [];
        for (const tid of topicIds) {
          if (chatPaneIds.has(tid)) continue;
          const shouldOpen = isLegacy ? !closedSet.has(tid) : openSet.has(tid);
          if (shouldOpen) {
            const topic = topics[tid];
            newChatPanes.push({
              id: createPaneId('chat', tid),
              type: 'chat' as PaneType,
              topicId: tid,
              title: topic?.name || 'Chat',
              preview: false,
            });
          }
        }
        if (newChatPanes.length > 0) updated = [...updated, ...newChatPanes];
      }

      // Title sync: update chat pane titles when topic names change
      let titleChanged = false;
      const titled = updated.map(p => {
        if (p.type === 'chat' && p.topicId) {
          const topic = topics[p.topicId];
          if (topic && topic.name !== p.title) {
            titleChanged = true;
            return { ...p, title: topic.name };
          }
        }
        return p;
      });
      if (titleChanged) updated = titled;

      return updated === prev ? prev : updated;
    });
  }, [topicIds, topics]);

  // --- Sync groups with panes (immutable, no mutations) ---
  useEffect(() => {
    setGroups(prev => {
      const allPaneIds = new Set(panes.map(p => p.id));
      let anyGroupChanged = false;
      let updated = prev.map(g => {
        const filtered = g.paneIds.filter(id => allPaneIds.has(id));
        if (filtered.length === g.paneIds.length) return g;
        anyGroupChanged = true;
        const activePaneId = filtered.includes(g.activePaneId)
          ? g.activePaneId
          : filtered[0] || g.activePaneId;
        return { ...g, paneIds: filtered, activePaneId };
      });
      const beforeFilterLen = updated.length;
      updated = updated.filter(g => g.paneIds.length > 0);
      if (updated.length !== beforeFilterLen) anyGroupChanged = true;

      // Build a lookup map: paneId → groupIndex (O(n) instead of nested searches)
      const paneToGroupIdx = new Map<string, number>();
      for (let i = 0; i < updated.length; i++) {
        for (const pid of updated[i].paneIds) {
          paneToGroupIdx.set(pid, i);
        }
      }

      const orphanPanes = panes.filter(p => !paneToGroupIdx.has(p.id));

      if (!anyGroupChanged && orphanPanes.length === 0) return prev;

      const orphansByType = new Map<PaneGroupType, Pane[]>();
      for (const p of orphanPanes) {
        const gt = paneTypeToGroupType(p.type);
        if (!orphansByType.has(gt)) orphansByType.set(gt, []);
        orphansByType.get(gt)!.push(p);
      }

      // Build groupId → index map for O(1) lookups
      const groupIdToIdx = new Map<string, number>();
      for (let i = 0; i < updated.length; i++) {
        groupIdToIdx.set(updated[i].id, i);
      }
      // Build groupType → first index map for O(1) type lookups
      const groupTypeToFirstIdx = new Map<PaneGroupType, number>();
      for (let i = 0; i < updated.length; i++) {
        if (!groupTypeToFirstIdx.has(updated[i].type)) {
          groupTypeToFirstIdx.set(updated[i].type, i);
        }
      }

      // Derive focused group from prev state instead of reading stale ref
      const curFocusedGroupId = focusedGroupIdRef.current;
      const focusedIdx = curFocusedGroupId ? groupIdToIdx.get(curFocusedGroupId) : undefined;
      const focusedGroup = focusedIdx !== undefined ? updated[focusedIdx] : null;

      for (const [gt, orphans] of orphansByType) {
        // Find target group using map lookups (O(1) each)
        let targetIdx: number | undefined;
        if (focusedGroup?.type === gt) {
          targetIdx = focusedIdx;
        }
        if (targetIdx === undefined) {
          targetIdx = groupTypeToFirstIdx.get(gt);
        }
        if (targetIdx === undefined && focusedIdx !== undefined) {
          targetIdx = focusedIdx;
        }
        if (targetIdx === undefined && updated.length > 0) {
          targetIdx = 0;
        }

        if (targetIdx !== undefined) {
          const tIdx = targetIdx;
          const previewOrphan = orphans.find(o => o.preview);
          if (previewOrphan) {
            const targetGroup = updated[tIdx];
            const existingPreview = findPreviewPane(
              targetGroup.paneIds.map(id => panes.find(p => p.id === id)).filter((p): p is Pane => !!p && paneTypeToGroupType(p.type) === gt),
              previewOrphan.id
            );
            if (existingPreview) {
              const newPaneIds = replacePaneInGroup(targetGroup.paneIds, existingPreview.id, previewOrphan.id);
              const otherOrphans = orphans.filter(o => o !== previewOrphan);
              updated = updated.map((g, i) => i === tIdx ? {
                ...g,
                paneIds: otherOrphans.length > 0 ? [...newPaneIds, ...otherOrphans.map(p => p.id)] : newPaneIds,
                activePaneId: previewOrphan.id,
              } : g);
              if (gt === 'chat' && existingPreview.topicId) {
                pendingPreviewCloseRef.current = existingPreview.topicId;
              }
              continue;
            }
          }
          updated = updated.map((g, i) => i === tIdx ? {
            ...g,
            paneIds: [...g.paneIds, ...orphans.map(p => p.id)],
          } : g);
        } else {
          const newGroup: PaneGroup = {
            id: createGroupId(),
            paneIds: orphans.map(p => p.id),
            activePaneId: orphans[0].id,
            type: gt,
          };
          updated = [...updated, newGroup];
        }
      }

      return updated;
    });
  }, [panes]);

  // --- Restore active chat (once) + sync rows/heights with groups (consolidated) ---
  const restoredActiveChatRef = useRef(false);
  useEffect(() => {
    // Restore active chat tab from persisted state (runs once)
    if (!restoredActiveChatRef.current) {
      const savedTopicId = persisted.current?.activeChatTopicId;
      if (!savedTopicId) {
        restoredActiveChatRef.current = true;
      } else {
        const chatGroup = groups.find(g => g.type === 'chat');
        if (chatGroup && chatGroup.paneIds.length > 0) {
          const targetPaneId = createPaneId('chat', savedTopicId);
          if (chatGroup.paneIds.includes(targetPaneId) && chatGroup.activePaneId !== targetPaneId) {
            restoredActiveChatRef.current = true;
            setGroups(prev => {
              const next = prev.map(g =>
                g.id === chatGroup.id ? { ...g, activePaneId: targetPaneId } : g
              );
              return next.some((g, i) => g !== prev[i]) ? next : prev;
            });
            setFocusedGroupId(chatGroup.id);
          } else if (chatGroup.paneIds.includes(targetPaneId)) {
            restoredActiveChatRef.current = true;
          }
        }
      }
    }

    // Sync rows with groups
    const curRows = rowsRef.current;
    const allGroupIds = new Set(groups.map(g => g.id));
    let anyRowChanged = false;
    let newRows = curRows.map(r => {
      const filtered = r.groupIds.filter(id => allGroupIds.has(id));
      if (filtered.length === r.groupIds.length) return r;
      anyRowChanged = true;
      const widths = filtered.map(() => 1 / filtered.length);
      return { groupIds: filtered, widths };
    });
    const beforeLen = newRows.length;
    newRows = newRows.filter(r => r.groupIds.length > 0);
    if (newRows.length !== beforeLen) anyRowChanged = true;

    const usedAfterClean = new Set(newRows.flatMap(r => r.groupIds));
    const newGroupIds = groups.filter(g => !usedAfterClean.has(g.id)).map(g => g.id);
    if (newGroupIds.length > 0) {
      anyRowChanged = true;
      if (newRows.length === 0) {
        newRows = [{ groupIds: newGroupIds, widths: newGroupIds.map(() => 1 / newGroupIds.length) }];
      } else {
        const firstRow = newRows[0];
        const all = [...firstRow.groupIds, ...newGroupIds];
        newRows = [{ groupIds: all, widths: all.map(() => 1 / all.length) }, ...newRows.slice(1)];
      }
    }

    if (newRows.length === 0 && groups.length > 0) {
      anyRowChanged = true;
      const gids = groups.map(g => g.id);
      newRows = [{ groupIds: gids, widths: gids.map(() => 1 / gids.length) }];
    }

    if (anyRowChanged) {
      setRows(newRows);
      // Sync heights: adjust if row count changed
      const curHeights = rowHeightsRef.current;
      if (newRows.length !== curHeights.length) {
        setRowHeights(newRows.map(() => 1 / newRows.length));
      }
    }
  }, [groups]);

  // Migration: if no groups but we have panes, build defaults
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current) return;
    if (groups.length === 0 && panes.length > 0) {
      migrated.current = true;
      const { groups: defaultGroups, rows: defaultRows } = buildDefaultGroups(panesRef.current);
      setGroups(defaultGroups);
      setRows(defaultRows);
    }
  }, [groups.length, panes.length]);

  // Open a topic that isn't currently open (e.g. clicked from sidebar)
  const reopenTopic = useCallback((topicId: string) => {
    const topic = topics[topicId];
    const paneId = createPaneId('chat', topicId);
    setPanes(prev => {
      if (prev.some(p => p.id === paneId)) return prev;
      return [...prev, {
        id: paneId,
        type: 'chat' as PaneType,
        topicId,
        title: topic?.name || 'Chat',
        preview: false,
      }];
    });
  }, [topics]);

  // Set focused group when focusedPanelId changes (external focus)
  const lastFocusedPanelRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedPanelId && !focusedPanelId.includes(':') && focusedPanelId !== lastFocusedPanelRef.current) {
      lastFocusedPanelRef.current = focusedPanelId;
      reopenTopic(focusedPanelId);
      const chatPaneId = createPaneId('chat', focusedPanelId);
      const chatPane = panes.find(p => p.id === chatPaneId);
      if (chatPane) {
        const g = groups.find(g => g.paneIds.includes(chatPane.id));
        if (g) {
          setFocusedGroupId(g.id);
          if (g.activePaneId !== chatPane.id) {
            setGroups(prev => {
              const next = prev.map(gg =>
                gg.id === g.id ? { ...gg, activePaneId: chatPane.id } : gg
              );
              return next.some((gg, i) => gg !== prev[i]) ? next : prev;
            });
          }
        }
      }
    }
  }, [focusedPanelId, panes, groups, reopenTopic]);

  // Handle pending focus from external navigation (e.g. search → topic in project)
  useEffect(() => {
    if (pendingFocusTopicId) {
      reopenTopic(pendingFocusTopicId);
      const chatPaneId = createPaneId('chat', pendingFocusTopicId);
      const chatPane = panes.find(p => p.id === chatPaneId);
      if (chatPane) {
        const g = groups.find(g => g.paneIds.includes(chatPane.id));
        if (g) {
          setFocusedGroupId(g.id);
          if (g.activePaneId !== chatPane.id) {
            setGroups(prev => {
              const next = prev.map(gg =>
                gg.id === g.id ? { ...gg, activePaneId: chatPane.id } : gg
              );
              return next.some((gg, i) => gg !== prev[i]) ? next : prev;
            });
          }
          // Consume only after successfully finding the pane AND its group
          onPendingFocusConsumed?.();
        }
      }
      // If pane/group not found yet, effect will re-run when panes/groups update
    }
  }, [pendingFocusTopicId, panes, groups, onPendingFocusConsumed, reopenTopic]);

  // If no focused group, set first one
  useEffect(() => {
    const focusedExists = focusedGroupId && groups.some(g => g.id === focusedGroupId);
    if (!focusedExists && groups.length > 0) {
      const chatGroup = groups.find(g => g.type === 'chat');
      setFocusedGroupId((chatGroup || groups[0]).id);
    }
  }, [focusedGroupId, groups]);

  // --- Handlers ---

  const handleActivatePane = useCallback((groupId: string, paneId: string) => {
    setFocusedGroupId(groupId);
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, activePaneId: paneId } : g
    ));
    // Always focus the project pane in the parent — internal group state
    // is already updated above, so we just need the parent to stay on this project tab.
    // (Sending a raw topicId would fail orderedIds lookup and fall back to orderedIds[0],
    // switching away from this project.)
    onFocusPanel(createPaneId('project', projectPath));
  }, [onFocusPanel, projectPath]);

  const handleClosePane = useCallback((groupId: string, paneId: string) => {
    const pane = panes.find(p => p.id === paneId);

    // Kill terminal session on the server when closing
    if (pane?.type === 'terminal') {
      const sessionId = getTerminalSessionFromPaneId(paneId);
      if (sessionId) {
        fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
      }
    }

    // Remove the pane from local state
    setPanes(prev => prev.filter(p => p.id !== paneId));

    setGroups(prev => {
      return prev.map(g => {
        if (g.id !== groupId) return g;
        const remaining = g.paneIds.filter(id => id !== paneId);
        if (remaining.length === 0) return { ...g, paneIds: [] };
        const newActive = g.activePaneId === paneId
          ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
          : g.activePaneId;
        return { ...g, paneIds: remaining, activePaneId: newActive };
      }).filter(g => g.paneIds.length > 0);
    });
  }, [panes]);

  const handleAddPaneToGroup = useCallback(async (groupId: string, type: PaneType, subType?: string) => {
    const config = PANE_CONFIG[type];
    if (config.singleton) {
      const targetGroup = groups.find(g => g.id === groupId);
      const groupPaneIds = new Set(targetGroup?.paneIds || []);
      const existingInGroup = panes.find(p => p.type === type && groupPaneIds.has(p.id));
      if (existingInGroup) {
        setFocusedGroupId(groupId);
        setGroups(prev => prev.map(gg =>
          gg.id === groupId ? { ...gg, activePaneId: existingInGroup.id } : gg
        ));
        return;
      }
    }

    let paneId: string;
    let paneTitle: string;

    if (type === 'terminal') {
      const termType = subType === 'claude-code' ? 'claude-code' : 'shell';
      paneTitle = termType === 'claude-code' ? 'Claude Code' : 'Shell';
      try {
        const body: Record<string, unknown> = { cwd: projectPath, type: termType, name: paneTitle };
        if (termType === 'claude-code') body.skipPermissions = claudeSkipPermissions;
        const res = await fetch('/api/terminal/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        const data = await res.json();
        paneId = createPaneId('terminal', data.id);
        paneTitle = data.name || paneTitle;
      } catch { return; }
    } else {
      paneId = createPaneId(type);
      paneTitle = PANE_CONFIG[type].label;
    }

    const newPane: Pane = {
      id: paneId,
      type,
      title: paneTitle,
      preview: type === 'terminal' ? false : true,
      ...(type === 'terminal' && subType ? { terminalType: subType as 'shell' | 'claude-code' } : {}),
    };

    const targetGroup = groups.find(g => g.id === groupId);
    const groupPanes = targetGroup?.paneIds.map(id => panes.find(p => p.id === id)).filter((p): p is Pane => !!p) || [];
    const existingPreview = type !== 'terminal' ? findPreviewPane(groupPanes.filter(p => p.type === type), newPane.id) : null;

    if (existingPreview) {
      setPanes(prev => prev.map(p => p.id === existingPreview.id ? newPane : p));
      setGroups(prev => prev.map(g =>
        g.id === groupId
          ? { ...g, paneIds: replacePaneInGroup(g.paneIds, existingPreview.id, newPane.id), activePaneId: newPane.id }
          : g
      ));
    } else {
      setPanes(prev => [...prev, newPane]);
      setGroups(prev => prev.map(g =>
        g.id === groupId
          ? { ...g, paneIds: [...g.paneIds, newPane.id], activePaneId: newPane.id }
          : g
      ));
    }
    setFocusedGroupId(groupId);
  }, [panes, groups, projectPath, claudeSkipPermissions]);

  const handleAddPaneWhenEmpty = useCallback(async (type: PaneType, subType?: string) => {
    const config = PANE_CONFIG[type];
    if (!config || config.fixed) return;

    let paneId: string;
    let paneTitle: string;

    if (type === 'terminal') {
      const termType = subType === 'claude-code' ? 'claude-code' : 'shell';
      paneTitle = termType === 'claude-code' ? 'Claude Code' : 'Shell';
      try {
        const body: Record<string, unknown> = { cwd: projectPath, type: termType, name: paneTitle };
        if (termType === 'claude-code') body.skipPermissions = claudeSkipPermissions;
        const res = await fetch('/api/terminal/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        const data = await res.json();
        paneId = createPaneId('terminal', data.id);
        paneTitle = data.name || paneTitle;
      } catch { return; }
    } else {
      paneId = createPaneId(type);
      paneTitle = config.label;
    }

    const newGroupId = createGroupId();
    const newPane: Pane = {
      id: paneId,
      type,
      title: paneTitle,
      preview: false,
      ...(type === 'terminal' && subType ? { terminalType: subType as 'shell' | 'claude-code' } : {}),
    };
    const newGroup: PaneGroup = {
      id: newGroupId,
      type: paneTypeToGroupType(type),
      paneIds: [newPane.id],
      activePaneId: newPane.id,
    };
    setPanes(prev => [...prev, newPane]);
    // Use updater form: if groups were concurrently populated (e.g. chat sync
    // effects ran while the async terminal session was being created), append
    // the new group instead of replacing — the rows sync effect will handle
    // placing it into the layout automatically.
    setGroups(prev => [...prev, newGroup]);
    setFocusedGroupId(newGroupId);
  }, [projectPath, claudeSkipPermissions]);

  // Handle pending pane request from sidebar — always add to focused/first group
  useEffect(() => {
    if (pendingPane) {
      // Terminal reattach: open an existing terminal session instead of creating a new one
      if (pendingPane === 'terminal' && pendingTerminalSessionId) {
        const paneId = createPaneId('terminal', pendingTerminalSessionId);
        const existing = panes.find(p => p.id === paneId);
        if (existing) {
          // Already open — just focus it
          const g = groups.find(g => g.paneIds.includes(paneId));
          if (g) {
            setFocusedGroupId(g.id);
            setGroups(prev => prev.map(gg =>
              gg.id === g.id ? { ...gg, activePaneId: paneId } : gg
            ));
          }
        } else {
          // Add as a new terminal pane in the focused/first group
          const newPane: Pane = { id: paneId, type: 'terminal', title: 'Terminal', preview: false };
          setPanes(prev => [...prev, newPane]);
          const targetGroupId = focusedGroupId || groups[0]?.id;
          if (targetGroupId) {
            setFocusedGroupId(targetGroupId);
            setGroups(prev => prev.map(g =>
              g.id === targetGroupId
                ? { ...g, paneIds: [...g.paneIds, paneId], activePaneId: paneId }
                : g
            ));
          }
        }
        onPendingPaneConsumed?.();
        return;
      }
      const targetGroupId = focusedGroupId || groups[0]?.id;
      if (targetGroupId) {
        handleAddPaneToGroup(targetGroupId, pendingPane);
      } else {
        // No groups exist yet — create one with the pending pane
        handleAddPaneWhenEmpty(pendingPane);
      }
      onPendingPaneConsumed?.();
    }
  }, [pendingPane, pendingTerminalSessionId, groups, focusedGroupId, panes, handleAddPaneToGroup, handleAddPaneWhenEmpty, onPendingPaneConsumed]);

  // Stable refs for effects and callbacks to avoid re-renders
  const panesRef = useRef(panes);
  const groupsRef = useRef(groups);
  const focusedGroupIdRef = useRef(focusedGroupId);
  const rowsRef = useRef(rows);
  const rowHeightsRef = useRef(rowHeights);
  panesRef.current = panes;
  groupsRef.current = groups;
  focusedGroupIdRef.current = focusedGroupId;
  rowsRef.current = rows;
  rowHeightsRef.current = rowHeights;

  const handleOpenFile = useCallback((path: string) => {
    const curPanes = panesRef.current;
    const curGroups = groupsRef.current;
    const curFocused = focusedGroupIdRef.current;

    const existing = curPanes.find(p => p.type === 'file' && p.filePath === path);
    if (existing) {
      const g = curGroups.find(g => g.paneIds.includes(existing.id));
      if (g) {
        setFocusedGroupId(g.id);
        setGroups(prev => prev.map(gg =>
          gg.id === g.id ? { ...gg, activePaneId: existing.id } : gg
        ));
      }
      return;
    }

    const filename = path.split('/').pop() || path;
    const newPane: Pane = {
      id: createPaneId('file'),
      type: 'file',
      filePath: path,
      title: filename,
      preview: true,
    };

    // Add to focused group (or first group) — never create a new group for files
    const targetGroup = (curFocused ? curGroups.find(g => g.id === curFocused) : null) || curGroups[0];
    if (!targetGroup) {
      // No groups at all — add pane and let orphan sync create a group
      setPanes(prev => [...prev, newPane]);
      return;
    }

    const groupPanes = targetGroup.paneIds.map(id => curPanes.find(p => p.id === id)).filter((p): p is Pane => !!p);
    const existingPreview = findPreviewPane(groupPanes.filter(p => p.type === 'file'), newPane.id);

    if (existingPreview) {
      setPanes(prev => prev.map(p => p.id === existingPreview.id ? newPane : p));
      setGroups(prev => prev.map(g =>
        g.id === targetGroup.id
          ? { ...g, paneIds: replacePaneInGroup(g.paneIds, existingPreview.id, newPane.id), activePaneId: newPane.id }
          : g
      ));
    } else {
      setPanes(prev => [...prev, newPane]);
      setGroups(prev => prev.map(g =>
        g.id === targetGroup.id
          ? { ...g, paneIds: [...g.paneIds, newPane.id], activePaneId: newPane.id }
          : g
      ));
    }
    setFocusedGroupId(targetGroup.id);
  }, []); // stable — reads from refs

  const handleOpenProcessLog = useCallback((processId: string, scriptName: string) => {
    const curPanes = panesRef.current;
    const curGroups = groupsRef.current;
    const curFocused = focusedGroupIdRef.current;

    const paneKey = `process-log:${processId}`;
    const existing = curPanes.find(p => p.id === paneKey);
    if (existing) {
      const g = curGroups.find(g => g.paneIds.includes(existing.id));
      if (g) {
        setFocusedGroupId(g.id);
        setGroups(prev => prev.map(gg =>
          gg.id === g.id ? { ...gg, activePaneId: existing.id } : gg
        ));
      }
      return;
    }

    const newPane: Pane = {
      id: paneKey,
      type: 'process-log',
      processId,
      title: scriptName,
    };

    const targetGroup = (curFocused ? curGroups.find(g => g.id === curFocused) : null) || curGroups[0];
    if (!targetGroup) {
      setPanes(prev => [...prev, newPane]);
      return;
    }

    setPanes(prev => [...prev, newPane]);
    setGroups(prev => prev.map(g =>
      g.id === targetGroup.id
        ? { ...g, paneIds: [...g.paneIds, newPane.id], activePaneId: newPane.id }
        : g
    ));
    setFocusedGroupId(targetGroup.id);
  }, []); // stable — reads from refs

  const handleOpenDiff = useCallback((filePath: string, diffProjectPath: string) => {
    const diffKey = `diff:${filePath}`;
    const existing = panes.find(p => p.type === 'file' && p.id === diffKey);
    if (existing) {
      const g = groups.find(g => g.paneIds.includes(existing.id));
      if (g) {
        setFocusedGroupId(g.id);
        setGroups(prev => prev.map(gg =>
          gg.id === g.id ? { ...gg, activePaneId: existing.id } : gg
        ));
      }
      return;
    }

    const filename = filePath.split('/').pop() || filePath;
    const fullPath = `${diffProjectPath}/${filePath}`;
    const newPane: Pane = {
      id: diffKey,
      type: 'file',
      filePath: fullPath,
      title: `${filename} (diff)`,
      diff: true,
      diffProjectPath,
      preview: true,
    };

    // Add to focused group (or first group) — never create a new group for diffs
    const targetGroup = (focusedGroupId ? groups.find(g => g.id === focusedGroupId) : null) || groups[0];
    if (!targetGroup) {
      setPanes(prev => [...prev, newPane]);
      return;
    }

    const groupPanes = targetGroup.paneIds.map(id => panes.find(p => p.id === id)).filter((p): p is Pane => !!p);
    const existingPreview = findPreviewPane(groupPanes.filter(p => p.type === 'file'), newPane.id);

    if (existingPreview) {
      setPanes(prev => prev.map(p => p.id === existingPreview.id ? newPane : p));
      setGroups(prev => prev.map(g =>
        g.id === targetGroup.id
          ? { ...g, paneIds: replacePaneInGroup(g.paneIds, existingPreview.id, newPane.id), activePaneId: newPane.id }
          : g
      ));
    } else {
      setPanes(prev => [...prev, newPane]);
      setGroups(prev => prev.map(g =>
        g.id === targetGroup.id
          ? { ...g, paneIds: [...g.paneIds, newPane.id], activePaneId: newPane.id }
          : g
      ));
    }
    setFocusedGroupId(targetGroup.id);
  }, [panes, groups, focusedGroupId]);

  // Listen for open-file events (e.g. from breadcrumb navigation)
  useEffect(() => {
    const handler = (e: Event) => {
      const { path } = (e as CustomEvent).detail;
      if (path) handleOpenFile(path);
    };
    window.addEventListener('open-file', handler);
    return () => window.removeEventListener('open-file', handler);
  }, [handleOpenFile]);

  // Listen for open-file-diff events from GitChanges sidebar
  useEffect(() => {
    const handler = (e: Event) => {
      const { filePath, projectPath: pp } = (e as CustomEvent).detail;
      handleOpenDiff(filePath, pp);
    };
    window.addEventListener('open-file-diff', handler);
    return () => window.removeEventListener('open-file-diff', handler);
  }, [handleOpenDiff]);

  // Listen for pin-file-pane events
  useEffect(() => {
    const handler = (e: Event) => {
      const { path } = (e as CustomEvent).detail;
      setPanes(prev => prev.map(p =>
        p.type === 'file' && p.filePath === path ? { ...p, preview: false } : p
      ));
    };
    window.addEventListener('pin-file-pane', handler);
    return () => window.removeEventListener('pin-file-pane', handler);
  }, []);

  // Close replaced preview pane
  useEffect(() => {
    if (pendingPreviewCloseRef.current) {
      const id = pendingPreviewCloseRef.current;
      pendingPreviewCloseRef.current = null;
      setPanes(prev => prev.filter(p => !(p.type === 'chat' && p.topicId === id)));
    }
  });

  const handleNewChatInGroup = useCallback((_groupId: string) => {
    onNewChat?.();
  }, [onNewChat]);

  const handlePinPane = useCallback((_groupId: string, paneId: string) => {
    setPanes(prev => prev.map(p => p.id === paneId ? { ...p, preview: false } : p));
  }, []);

  const handleReorderGroupPanes = useCallback((groupId: string, newPaneIds: string[]) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, paneIds: newPaneIds } : g
    ));
  }, []);

  const handleMovePaneBetweenGroups = useCallback((sourceGroupId: string, targetGroupId: string, paneId: string, insertIdx: number) => {
    setGroups(prev => {
      const sourceGroup = prev.find(g => g.id === sourceGroupId);
      const targetGroup = prev.find(g => g.id === targetGroupId);
      if (!sourceGroup || !targetGroup) return prev;
      if (!sourceGroup.paneIds.includes(paneId)) return prev;

      return prev.map(g => {
        if (g.id === sourceGroupId) {
          const remaining = g.paneIds.filter(id => id !== paneId);
          const newActive = remaining.length > 0
            ? (g.activePaneId === paneId
              ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
              : g.activePaneId)
            : g.activePaneId;
          return { ...g, paneIds: remaining, activePaneId: newActive };
        }
        if (g.id === targetGroupId) {
          const newPaneIds = [...g.paneIds];
          newPaneIds.splice(Math.max(0, Math.min(insertIdx, newPaneIds.length)), 0, paneId);
          return { ...g, paneIds: newPaneIds, activePaneId: paneId };
        }
        return g;
      }).filter(g => g.paneIds.length > 0);
    });
    setFocusedGroupId(targetGroupId);
  }, []);

  const handleSplitGroup = useCallback((sourceGroupId: string, paneId: string, targetGroupId: string, edge: 'left' | 'right' | 'top' | 'bottom') => {
    const pane = panes.find(p => p.id === paneId);
    if (!pane) return;

    const newGroupId = createGroupId();
    const newGroup: PaneGroup = {
      id: newGroupId,
      paneIds: [paneId],
      activePaneId: paneId,
      type: paneTypeToGroupType(pane.type),
    };

    setGroups(prev => {
      const updated = prev.map(g => {
        if (g.id === sourceGroupId) {
          const remaining = g.paneIds.filter(id => id !== paneId);
          const newActive = remaining.length > 0
            ? (g.activePaneId === paneId
              ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
              : g.activePaneId)
            : g.activePaneId;
          return { ...g, paneIds: remaining, activePaneId: newActive };
        }
        return g;
      }).filter(g => g.paneIds.length > 0);

      return [...updated, newGroup];
    });

    setRows(prev => {
      if (edge === 'left' || edge === 'right') {
        return prev.map(row => {
          const targetIdx = row.groupIds.indexOf(targetGroupId);
          if (targetIdx === -1) return row;
          const newGroupIds = [...row.groupIds];
          const insertAt = edge === 'left' ? targetIdx : targetIdx + 1;
          newGroupIds.splice(insertAt, 0, newGroupId);
          const newWidths = newGroupIds.map(() => 1 / newGroupIds.length);
          return { groupIds: newGroupIds, widths: newWidths };
        });
      } else {
        const targetRowIdx = prev.findIndex(row => row.groupIds.includes(targetGroupId));
        if (targetRowIdx === -1) return prev;
        const newRow = { groupIds: [newGroupId], widths: [1] };
        const newRows = [...prev];
        const insertAt = edge === 'top' ? targetRowIdx : targetRowIdx + 1;
        newRows.splice(insertAt, 0, newRow);
        // Split target row's height in half for the new row
        setRowHeights(prevH => {
          const newHeights = [...prevH];
          const halfHeight = (newHeights[targetRowIdx] || 1 / prevH.length) / 2;
          newHeights[targetRowIdx] = halfHeight;
          newHeights.splice(insertAt, 0, halfHeight);
          return newHeights;
        });
        return newRows;
      }
    });

    setFocusedGroupId(newGroupId);
  }, [panes]);

  const handleReorderRows = useCallback((newRowOrder: number[]) => {
    setRows(prev => {
      const newRows = newRowOrder.map(i => prev[i]).filter(Boolean);
      return newRows;
    });
    setRowHeights(prev => {
      const newHeights = newRowOrder.map(i => prev[i]).filter(h => h !== undefined);
      return newHeights;
    });
  }, []);

  const availableTypesForGroup = useCallback((groupType: PaneGroupType, groupId: string): PaneType[] => {
    const types: PaneType[] = ['browser', 'terminal', 'git', 'board-memory'];
    if (groupType === 'file') {
      types.unshift('files');
    }
    const targetGroup = groups.find(g => g.id === groupId);
    const groupPaneIds = new Set(targetGroup?.paneIds || []);
    return types.filter(t => {
      const config = PANE_CONFIG[t];
      if (config.fixed) return false;
      if (config.singleton && panes.some(p => p.type === t && groupPaneIds.has(p.id))) return false;
      return true;
    });
  }, [panes, groups]);

  const handlePaneSettings = useCallback((paneId: string) => {
    const pane = panes.find(p => p.id === paneId);
    if (pane?.topicId) setSettingsTopicId(pane.topicId);
  }, [panes]);

  const handlePanePopOut = useCallback((paneId: string) => {
    const pane = panes.find(p => p.id === paneId);
    if (!pane?.topicId) return;
    const url = `${window.location.origin}?topic=${pane.topicId}`;
    isNativeApp
      ? window.open(url, `topic-${pane.topicId}`, 'width=900,height=700')
      : window.open(url, `topic-${pane.topicId}`);
    // Close the tab locally
    setPanes(prev => prev.filter(p => p.id !== paneId));
  }, [panes]);

  const primaryTopicId = topicIds[0];

  const renderPane = useCallback((pane: Pane, isFocused: boolean) => {
    switch (pane.type) {
      case 'chat': {
        const topic = pane.topicId ? topics[pane.topicId] : null;
        if (!topic) return <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">Topic not found</div>;
        const wrappedSendMessage = pane.preview
          ? async (sk: string, content: string, options?: { planMode?: boolean }) => {
              setPanes(prev => prev.map(p => p.id === pane.id ? { ...p, preview: false } : p));
              return sendMessage(sk, content, options);
            }
          : sendMessage;
        return (
          <ChatPane
            topic={topic}
            isFocused={isFocused && focusedPanelId === createPaneId('project', projectPath)}
            getSessionMessages={getSessionMessages}
            isSessionLoading={isSessionLoading}
            isSessionStreaming={isSessionStreaming}
            sendMessage={wrappedSendMessage}
            editMessage={editMessage}
            switchBranch={switchBranch}
            loadHistory={loadHistory}
            chatError={chatError}
            sendWS={sendWS}
            onWSMessage={onWSMessage}
            onUpdateTopic={onUpdateTopic}
            onOpenFile={handleOpenFile}
          />
        );
      }
      case 'browser':
        return (
          <Suspense fallback={LazySpinner}>
            <RemoteBrowserPanel contextId={projectPath} />
          </Suspense>
        );
      case 'terminal': {
        const sessionId = getTerminalSessionFromPaneId(pane.id);
        if (!sessionId) return null;
        return (
          <Suspense fallback={LazySpinner}>
            <SingleTerminalPane sessionId={sessionId} />
          </Suspense>
        );
      }
      case 'file':
        return pane.filePath ? (
          <Suspense fallback={LazySpinner}>
            <FilePane
              filePath={pane.filePath}
              projectPath={projectPath}
              diff={pane.diff}
              diffProjectPath={pane.diffProjectPath}
              onPin={pane.preview ? () => setPanes(prev => prev.map(p => p.id === pane.id ? { ...p, preview: false } : p)) : undefined}
            />
          </Suspense>
        ) : null;
      case 'files':
        return (
          <Suspense fallback={LazySpinner}>
            <FileExplorer projectPath={projectPath} />
          </Suspense>
        );
      case 'git':
        return (
          <Suspense fallback={LazySpinner}>
            <GitChanges projectPath={projectPath} />
          </Suspense>
        );
      case 'activity':
        return (
          <Suspense fallback={LazySpinner}>
            <ActivityPane />
          </Suspense>
        );
      case 'journal':
        return (
          <Suspense fallback={LazySpinner}>
            <JournalPane />
          </Suspense>
        );
      case 'agents':
        return (
          <Suspense fallback={LazySpinner}>
            <AgentsPane onNavigateToTopic={(topicId) => onFocusPanel(topicId)} onMessage={onWSMessage} />
          </Suspense>
        );
      case 'board':
        return (
          <Suspense fallback={LazySpinner}>
            <KanbanBoard projectId={encodeURIComponent(projectPath)} topicId={primaryTopicId} onWSMessage={onWSMessage} />
          </Suspense>
        );
      case 'board-memory':
        return (
          <Suspense fallback={LazySpinner}>
            <BoardMemoryPanel projectId={encodeURIComponent(projectPath)} onWSMessage={onWSMessage} />
          </Suspense>
        );
      case 'dashboard':
        return (
          <Suspense fallback={LazySpinner}>
            <DashboardPane />
          </Suspense>
        );
      case 'process-log':
        return pane.processId ? (
          <Suspense fallback={LazySpinner}>
            <ProcessLogPane processId={pane.processId} scriptName={pane.title} />
          </Suspense>
        ) : null;
      default:
        return null;
    }
  }, [
    topics, focusedPanelId, projectPath,
    getSessionMessages, isSessionLoading, isSessionStreaming,
    sendMessage, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
    handleOpenFile,
  ]);

  return (
    <>
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden relative">
        <ProjectSidebar
          projectPath={projectPath}
          topicId={primaryTopicId}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
          onOpenFile={handleOpenFile}
          onWSMessage={onWSMessage}
          onOpenProcessLog={handleOpenProcessLog}
          onOpenBoard={() => {
            const targetGroupId = focusedGroupId || groups[0]?.id;
            if (targetGroupId) {
              handleAddPaneToGroup(targetGroupId, 'board');
            } else {
              // No groups exist yet -- use handleAddPaneWhenEmpty to create one
              handleAddPaneWhenEmpty('board');
            }
          }}
        />
        <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <GroupLayout
            panes={panes}
            groups={groups}
            rows={rows}
            rowHeights={rowHeights}
            focusedGroupId={focusedGroupId}
            onActivatePane={handleActivatePane}
            onClosePane={handleClosePane}
            onAddPaneToGroup={handleAddPaneToGroup}
            onNewChatInGroup={onNewChat ? handleNewChatInGroup : undefined}
            onAddPaneWhenEmpty={handleAddPaneWhenEmpty}
            onReorderGroupPanes={handleReorderGroupPanes}
            onMovePaneBetweenGroups={handleMovePaneBetweenGroups}
            onSplitGroup={handleSplitGroup}
            onReorderRows={handleReorderRows}
            onUpdateRows={setRows}
            onUpdateRowHeights={setRowHeights}
            renderPane={renderPane}
            availableTypesForGroup={availableTypesForGroup}
            contextPercent={contextPercent}
            onContextRingClick={() => setShowContext(prev => !prev)}
            streamingPaneIds={streamingPaneIds}
            onStopStreaming={handleStopStreaming}
            onSettings={handlePaneSettings}
            onPopOut={handlePanePopOut}
            onPinPane={handlePinPane}
          />
        </div>
        {showContext && activeTopic && (
          <div className={`overflow-hidden transition-all duration-200 ${isNarrow ? 'absolute inset-0 z-40' : 'w-[320px] flex-shrink-0 border-l border-app-border'}`}>
            <Suspense fallback={LazySpinner}>
              <ContextInspector
                topic={activeTopic}
                isOpen={showContext}
                onClose={() => setShowContext(false)}
                onUpdateTopic={onUpdateTopic}
                onMessage={onWSMessage}
                onOpenFile={handleOpenFile}
              />
            </Suspense>
          </div>
        )}
      </div>
      {settingsTopicId && topics[settingsTopicId] && (
        <Suspense fallback={null}>
          <TopicSettingsModal
            topic={topics[settingsTopicId]}
            isOpen={!!settingsTopicId}
            onClose={() => setSettingsTopicId(null)}
            onUpdate={onUpdateTopic}
          />
        </Suspense>
      )}
    </>
  );
}

// --- Original ProjectWindow: thin wrapper with header ---

interface ProjectWindowProps {
  projectPath: string;
  topicIds: string[];
  topics: Record<string, Topic>;
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string) => void;
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  stopSession: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onOpenInFinder?: () => void;
  onGroupDragStart?: (e: React.DragEvent) => void;
  onCloseProject?: () => void;
  pendingPane?: PaneType;
  onPendingPaneConsumed?: () => void;
  onNewChat?: () => void;
  onAcceptTopicDrop?: (topicId: string) => void;
}

export function ProjectWindow({
  projectPath, topicIds, topics, focusedPanelId,
  onFocusPanel, onClosePanel,
  getSessionMessages, isSessionLoading, isSessionStreaming, stopSession,
  sendMessage, editMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onOpenInFinder, onGroupDragStart, onCloseProject, pendingPane, onPendingPaneConsumed, onNewChat,
  onAcceptTopicDrop,
}: ProjectWindowProps) {
  // Cross-panel-type drop: accept standalone chat drops
  const [panelDragOver, setPanelDragOver] = useState(false);

  const handleProjectDragOver = useCallback((e: React.DragEvent) => {
    if (!onAcceptTopicDrop) return;
    if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
    if (e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM)) return;
    e.preventDefault();
    setPanelDragOver(true);
  }, [onAcceptTopicDrop]);

  const handleProjectDragLeave = useCallback(() => {
    setPanelDragOver(false);
  }, []);

  const handleProjectDrop = useCallback((e: React.DragEvent) => {
    if (!onAcceptTopicDrop) return;
    const topicId = e.dataTransfer.getData(DND_TYPES.PANEL_ID);
    if (!topicId) return;
    if (topicIds.includes(topicId)) return;
    e.preventDefault();
    e.stopPropagation();
    setPanelDragOver(false);
    onAcceptTopicDrop(topicId);
  }, [onAcceptTopicDrop, topicIds]);

  return (
    <div
      className={`relative flex flex-col min-h-0 min-w-[200px] overflow-hidden transition-all ${panelDragOver ? 'ring-2 ring-primary/50' : ''}`}
      style={{ flex: 1 }}
      onDragOver={handleProjectDragOver}
      onDragLeave={handleProjectDragLeave}
      onDrop={handleProjectDrop}
    >
      {/* Project header — draggable for group reordering */}
      <div
        draggable={!!onGroupDragStart}
        onDragStart={onGroupDragStart}
        className={onGroupDragStart ? 'cursor-grab active:cursor-grabbing' : ''}
      >
        <ProjectHeader
          projectPath={projectPath}
          projectName={getProjectName(projectPath)}
          onOpenInFinder={onOpenInFinder}
          onClose={onCloseProject}
        />
      </div>

      {/* Main content: delegates to ProjectWindowPane */}
      <ProjectWindowPane
        projectPath={projectPath}
        topics={topics}
        focusedPanelId={focusedPanelId}
        onFocusPanel={onFocusPanel}
        onClosePanel={onClosePanel}
        getSessionMessages={getSessionMessages}
        isSessionLoading={isSessionLoading}
        isSessionStreaming={isSessionStreaming}
        stopSession={stopSession}
        sendMessage={sendMessage}
        editMessage={editMessage}
        switchBranch={switchBranch}
        loadHistory={loadHistory}
        chatError={chatError}
        sendWS={sendWS}
        onWSMessage={onWSMessage}
        onUpdateTopic={onUpdateTopic}
        pendingPane={pendingPane}
        onPendingPaneConsumed={onPendingPaneConsumed}
        onNewChat={onNewChat}
      />
      <ToastOutlet />
    </div>
  );
}
