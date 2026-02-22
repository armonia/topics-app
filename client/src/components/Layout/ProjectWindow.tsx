import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PaneGroup, PaneGroupType, GroupLayoutRow } from '../../types';
import { ProjectHeader, getProjectName } from './ProjectHeader';
import { ProjectSidebar } from '../Project/ProjectSidebar';
import { GroupLayout } from './GroupLayout';
import { ChatPane } from '../Chat/ChatPane';
import { createPaneId, createGroupId, PANE_CONFIG } from '../../lib/paneConfig';
import { DND_TYPES } from '../../lib/dndTypes';
import { useMultiContextPercent } from '../../hooks/useContextInspector';

const ContextInspector = lazy(() => import('../Context/ContextInspector').then(m => ({ default: m.ContextInspector })));
const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const TerminalPanel = lazy(() => import('../Terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const FileExplorer = lazy(() => import('../Project/FileExplorer').then(m => ({ default: m.FileExplorer })));
const FilePane = lazy(() => import('../Editor/FilePane').then(m => ({ default: m.FilePane })));
const GitChanges = lazy(() => import('../Project/GitChanges').then(m => ({ default: m.GitChanges })));
const ActivityPane = lazy(() => import('../Sidebar/ActivityPane').then(m => ({ default: m.ActivityPane })));
const JournalPane = lazy(() => import('../Journal/JournalPane').then(m => ({ default: m.JournalPane })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
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
}

function loadPersistedState(projectPath: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(storageKey(projectPath));
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function savePersistedState(projectPath: string, state: PersistedState) {
  try {
    localStorage.setItem(storageKey(projectPath), JSON.stringify(state));
  } catch {}
}

// Map PaneType → PaneGroupType
function paneTypeToGroupType(type: PaneType): PaneGroupType {
  if (type === 'chat') return 'chat';
  if (type === 'file' || type === 'files') return 'file';
  return 'utility';
}

// Build default groups from a flat list of panes (migration from old format)
function buildDefaultGroups(panes: Pane[]): { groups: PaneGroup[]; rows: GroupLayoutRow[] } {
  const chatPanes = panes.filter(p => p.type === 'chat');
  const filePanes = panes.filter(p => p.type === 'file' || p.type === 'files');
  const utilPanes = panes.filter(p => p.type !== 'chat' && p.type !== 'file' && p.type !== 'files');

  const groups: PaneGroup[] = [];
  const rowGroupIds: string[] = [];

  if (chatPanes.length > 0) {
    const g: PaneGroup = {
      id: createGroupId(),
      paneIds: chatPanes.map(p => p.id),
      activePaneId: chatPanes[0].id,
      type: 'chat',
    };
    groups.push(g);
    rowGroupIds.push(g.id);
  }

  if (filePanes.length > 0) {
    const g: PaneGroup = {
      id: createGroupId(),
      paneIds: filePanes.map(p => p.id),
      activePaneId: filePanes[0].id,
      type: 'file',
    };
    groups.push(g);
    rowGroupIds.push(g.id);
  }

  if (utilPanes.length > 0) {
    const g: PaneGroup = {
      id: createGroupId(),
      paneIds: utilPanes.map(p => p.id),
      activePaneId: utilPanes[0].id,
      type: 'utility',
    };
    groups.push(g);
    rowGroupIds.push(g.id);
  }

  const rows: GroupLayoutRow[] = rowGroupIds.length > 0
    ? [{ groupIds: rowGroupIds, widths: rowGroupIds.map(() => 1 / rowGroupIds.length) }]
    : [];

  return { groups, rows };
}

const LazySpinner = <div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" /></div>;

interface ProjectWindowProps {
  projectPath: string;
  topicIds: string[];
  topics: Record<string, Topic>;
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string) => void;
  // Chat props pass-through
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  stopSession: (sk: string) => void;
  sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onOpenInFinder?: () => void;
  // Group drag
  onGroupDragStart?: (e: React.DragEvent) => void;
  // Close entire project
  onCloseProject?: () => void;
  // Pending pane from sidebar (e.g. terminal)
  pendingPane?: PaneType;
  onPendingPaneConsumed?: () => void;
  // Create new chat in this project
  onNewChat?: () => void;
  // Accept topic drop from standalone (cross-panel-type)
  onAcceptTopicDrop?: (topicId: string) => void;
}

export function ProjectWindow({
  projectPath, topicIds, topics, focusedPanelId,
  onFocusPanel, onClosePanel,
  getSessionMessages, isSessionLoading, isSessionStreaming, stopSession,
  sendMessage, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onOpenInFinder, onGroupDragStart, onCloseProject, pendingPane, onPendingPaneConsumed, onNewChat,
  onAcceptTopicDrop,
}: ProjectWindowProps) {
  // Load persisted state
  const persisted = useRef(loadPersistedState(projectPath));

  // Responsive: overlay context inspector when window is narrow
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 1024);
  useEffect(() => { const h = () => setIsNarrow(window.innerWidth < 1024); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  // --- Core state ---
  const [panes, setPanes] = useState<Pane[]>(() => persisted.current?.nonChatPanes || []);
  const [groups, setGroups] = useState<PaneGroup[]>(() => persisted.current?.groups || []);
  const [rows, setRows] = useState<GroupLayoutRow[]>(() => persisted.current?.rows || []);
  const [rowHeights, setRowHeights] = useState<number[]>(() => persisted.current?.rowHeights || [1]);
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => persisted.current?.sidebarCollapsed ?? false);
  const [showContext, setShowContext] = useState(() => {
    try { return localStorage.getItem('topics-context-inspector-open') === 'true'; } catch { return false; }
  });
  // Settings modal state (opened via right-click menu on tabs)
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);

  // Determine active topic for Context Inspector (from focused group)
  const focusedGroup = groups.find(g => g.id === focusedGroupId);
  const focusedPane = focusedGroup ? panes.find(p => p.id === focusedGroup.activePaneId) : null;
  const activeTopicId = focusedPane?.type === 'chat' ? focusedPane.topicId || null : null;
  const activeTopic = activeTopicId ? topics[activeTopicId] : null;
  // Build paneId → topicId map for context rings on chat tabs
  const paneToTopicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of panes) {
      if (p.type === 'chat' && p.topicId) map[p.id] = p.topicId;
    }
    return map;
  }, [panes]);
  const contextPercent = useMultiContextPercent(paneToTopicMap);

  // Build set of pane IDs that are currently streaming
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

  // Stop streaming for a pane (by pane ID)
  const handleStopStreaming = useCallback((paneId: string) => {
    const pane = panes.find(p => p.id === paneId);
    if (pane?.topicId) {
      const topic = topics[pane.topicId];
      if (topic) {
        const isFirst = stopSession(topic.sessionKey);
        if (isFirst) onClosePanel(pane.topicId);
      }
    }
  }, [panes, topics, stopSession, onClosePanel]);

  // Persist context inspector state
  useEffect(() => {
    try { localStorage.setItem('topics-context-inspector-open', String(showContext)); } catch {}
  }, [showContext]);

  // Persist non-chat panes, groups, rows
  useEffect(() => {
    const nonChatPanes = panes.filter(p => p.type !== 'chat');
    // Filter groups to exclude chat groups (they're rebuilt from topicIds)
    const nonChatGroups = groups.filter(g => g.type !== 'chat').map(g => ({
      ...g,
      paneIds: g.paneIds.filter(id => nonChatPanes.some(p => p.id === id)),
    })).filter(g => g.paneIds.length > 0);
    savePersistedState(projectPath, {
      nonChatPanes,
      groups: nonChatGroups,
      rows,
      rowHeights,
      sidebarCollapsed,
    });
  }, [panes, groups, rows, rowHeights, sidebarCollapsed, projectPath]);

  // --- Sync chat panes with topicIds ---
  useEffect(() => {
    setPanes(prev => {
      const chatPaneIds = new Set(prev.filter(p => p.type === 'chat').map(p => p.topicId));
      const currentTopicIds = new Set(topicIds);

      // Remove chat panes for topics that are no longer open
      let updated = prev.filter(p => p.type !== 'chat' || (p.topicId && currentTopicIds.has(p.topicId)));

      // Add chat panes for new topics
      const newChatPanes: Pane[] = [];
      for (const tid of topicIds) {
        if (!chatPaneIds.has(tid)) {
          const topic = topics[tid];
          newChatPanes.push({
            id: createPaneId('chat', tid),
            type: 'chat' as PaneType,
            topicId: tid,
            title: topic?.name || 'Chat',
          });
        }
      }
      if (newChatPanes.length > 0) updated = [...updated, ...newChatPanes];

      return updated;
    });
  }, [topicIds, topics]);

  // Update chat pane titles when topic names change
  useEffect(() => {
    setPanes(prev => prev.map(p => {
      if (p.type === 'chat' && p.topicId) {
        const topic = topics[p.topicId];
        if (topic && topic.name !== p.title) {
          return { ...p, title: topic.name };
        }
      }
      return p;
    }));
  }, [topics]);

  // --- Sync groups with panes ---
  useEffect(() => {
    setGroups(prev => {
      const allPaneIds = new Set(panes.map(p => p.id));

      // Clean stale paneIds from existing groups
      let updated = prev.map(g => {
        const filtered = g.paneIds.filter(id => allPaneIds.has(id));
        if (filtered.length === g.paneIds.length) return g;
        const activePaneId = filtered.includes(g.activePaneId)
          ? g.activePaneId
          : filtered[0] || g.activePaneId;
        return { ...g, paneIds: filtered, activePaneId };
      }).filter(g => g.paneIds.length > 0);

      // Find panes not yet in any group
      const usedAfterClean = new Set(updated.flatMap(g => g.paneIds));
      const orphanPanes = panes.filter(p => !usedAfterClean.has(p.id));

      // Group orphans by group type
      const orphansByType = new Map<PaneGroupType, Pane[]>();
      for (const p of orphanPanes) {
        const gt = paneTypeToGroupType(p.type);
        if (!orphansByType.has(gt)) orphansByType.set(gt, []);
        orphansByType.get(gt)!.push(p);
      }

      // Add orphans to existing groups of matching type, or create new groups
      for (const [gt, orphans] of orphansByType) {
        const existingGroup = updated.find(g => g.type === gt);
        if (existingGroup) {
          existingGroup.paneIds = [...existingGroup.paneIds, ...orphans.map(p => p.id)];
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

  // --- Sync rows with groups ---
  useEffect(() => {
    setRows(prev => {
      const allGroupIds = new Set(groups.map(g => g.id));

      // Remove groups from rows that no longer exist
      let newRows = prev.map(r => {
        const filtered = r.groupIds.filter(id => allGroupIds.has(id));
        if (filtered.length === r.groupIds.length) return r;
        const widths = filtered.map(() => 1 / filtered.length);
        return { groupIds: filtered, widths };
      }).filter(r => r.groupIds.length > 0);

      // Add new groups to first row
      const usedAfterClean = new Set(newRows.flatMap(r => r.groupIds));
      const newGroupIds = groups.filter(g => !usedAfterClean.has(g.id)).map(g => g.id);
      if (newGroupIds.length > 0) {
        if (newRows.length === 0) {
          newRows = [{ groupIds: newGroupIds, widths: newGroupIds.map(() => 1 / newGroupIds.length) }];
        } else {
          const firstRow = newRows[0];
          const all = [...firstRow.groupIds, ...newGroupIds];
          newRows[0] = { groupIds: all, widths: all.map(() => 1 / all.length) };
        }
      }

      if (newRows.length === 0 && groups.length > 0) {
        const gids = groups.map(g => g.id);
        newRows = [{ groupIds: gids, widths: gids.map(() => 1 / gids.length) }];
      }

      return newRows;
    });
  }, [groups]);

  // Sync rowHeights
  useEffect(() => {
    setRowHeights(prev => {
      if (prev.length === rows.length) return prev;
      return rows.map(() => 1 / rows.length);
    });
  }, [rows]);

  // Migration: if no groups but we have panes, build defaults
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current) return;
    if (groups.length === 0 && panes.length > 0) {
      migrated.current = true;
      const { groups: defaultGroups, rows: defaultRows } = buildDefaultGroups(panes);
      setGroups(defaultGroups);
      setRows(defaultRows);
    }
  }, [groups.length, panes]);

  // Set focused group when focusedPanelId changes (external focus)
  useEffect(() => {
    if (focusedPanelId) {
      const chatPane = panes.find(p => p.type === 'chat' && p.topicId === focusedPanelId);
      if (chatPane) {
        const g = groups.find(g => g.paneIds.includes(chatPane.id));
        if (g) {
          setFocusedGroupId(g.id);
          if (g.activePaneId !== chatPane.id) {
            setGroups(prev => prev.map(gg =>
              gg.id === g.id ? { ...gg, activePaneId: chatPane.id } : gg
            ));
          }
        }
      }
    }
  }, [focusedPanelId, panes, groups]);

  // If no focused group, set first one
  useEffect(() => {
    if (!focusedGroupId && groups.length > 0) {
      setFocusedGroupId(groups[0].id);
    }
  }, [focusedGroupId, groups]);

  // --- Handlers ---

  const handleActivatePane = useCallback((groupId: string, paneId: string) => {
    setFocusedGroupId(groupId);
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, activePaneId: paneId } : g
    ));
    const pane = panes.find(p => p.id === paneId);
    if (pane?.type === 'chat' && pane.topicId) {
      onFocusPanel(pane.topicId);
    }
  }, [panes, onFocusPanel]);

  const handleClosePane = useCallback((groupId: string, paneId: string) => {
    const pane = panes.find(p => p.id === paneId);

    if (pane?.type === 'chat' && pane.topicId) {
      // Check if this is the last chat pane — if so, auto-close the project
      const chatPanes = panes.filter(p => p.type === 'chat');
      if (chatPanes.length <= 1 && onCloseProject) {
        onCloseProject();
        return;
      }
      onClosePanel(pane.topicId);
    } else {
      setPanes(prev => prev.filter(p => p.id !== paneId));
    }

    // Update group: remove pane, pick new active if needed
    setGroups(prev => {
      return prev.map(g => {
        if (g.id !== groupId) return g;
        const remaining = g.paneIds.filter(id => id !== paneId);
        if (remaining.length === 0) return g; // will be cleaned by sync
        const newActive = g.activePaneId === paneId
          ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
          : g.activePaneId;
        return { ...g, paneIds: remaining, activePaneId: newActive };
      }).filter(g => g.paneIds.length > 0);
    });
  }, [panes, onClosePanel, onCloseProject]);

  const handleAddPaneToGroup = useCallback((groupId: string, type: PaneType) => {
    // Singleton check
    const config = PANE_CONFIG[type];
    if (config.singleton) {
      const existing = panes.find(p => p.type === type);
      if (existing) {
        // Focus the group containing this singleton
        const g = groups.find(g => g.paneIds.includes(existing.id));
        if (g) {
          setFocusedGroupId(g.id);
          setGroups(prev => prev.map(gg =>
            gg.id === g.id ? { ...gg, activePaneId: existing.id } : gg
          ));
        }
        return;
      }
    }

    const newPane: Pane = {
      id: createPaneId(type),
      type,
      title: PANE_CONFIG[type].label,
    };
    setPanes(prev => [...prev, newPane]);
    setGroups(prev => prev.map(g =>
      g.id === groupId
        ? { ...g, paneIds: [...g.paneIds, newPane.id], activePaneId: newPane.id }
        : g
    ));
    setFocusedGroupId(groupId);
  }, [panes, groups]);

  // Handle pending pane request from sidebar
  useEffect(() => {
    if (pendingPane) {
      // Find a utility group, or the focused group, to add to
      const utilGroup = groups.find(g => g.type === 'utility');
      const targetGroupId = utilGroup?.id || focusedGroupId || groups[0]?.id;
      if (targetGroupId) {
        handleAddPaneToGroup(targetGroupId, pendingPane);
      }
      onPendingPaneConsumed?.();
    }
  }, [pendingPane, groups, focusedGroupId, handleAddPaneToGroup, onPendingPaneConsumed]);

  const handleOpenFile = useCallback((path: string) => {
    // Check if a file pane for this path already exists
    const existing = panes.find(p => p.type === 'file' && p.filePath === path);
    if (existing) {
      // Focus the group containing it
      const g = groups.find(g => g.paneIds.includes(existing.id));
      if (g) {
        setFocusedGroupId(g.id);
        setGroups(prev => prev.map(gg =>
          gg.id === g.id ? { ...gg, activePaneId: existing.id } : gg
        ));
      }
      return;
    }

    // Create new file pane
    const filename = path.split('/').pop() || path;
    const newPane: Pane = {
      id: createPaneId('file'),
      type: 'file',
      filePath: path,
      title: filename,
    };

    // Find file group or create one
    const fileGroup = groups.find(g => g.type === 'file');
    if (fileGroup) {
      setPanes(prev => [...prev, newPane]);
      setGroups(prev => prev.map(g =>
        g.id === fileGroup.id
          ? { ...g, paneIds: [...g.paneIds, newPane.id], activePaneId: newPane.id }
          : g
      ));
      setFocusedGroupId(fileGroup.id);
    } else {
      // Create new file group — sync effects will place it in rows
      const newGroup: PaneGroup = {
        id: createGroupId(),
        paneIds: [newPane.id],
        activePaneId: newPane.id,
        type: 'file',
      };
      setPanes(prev => [...prev, newPane]);
      setGroups(prev => [...prev, newGroup]);
      setFocusedGroupId(newGroup.id);
    }
  }, [panes, groups]);

  const handleNewChatInGroup = useCallback((_groupId: string) => {
    onNewChat?.();
  }, [onNewChat]);

  const handleReorderGroupPanes = useCallback((groupId: string, newPaneIds: string[]) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, paneIds: newPaneIds } : g
    ));
  }, []);

  // Move a pane tab from one group to another (cross-group tab drag)
  const handleMovePaneBetweenGroups = useCallback((sourceGroupId: string, targetGroupId: string, paneId: string, insertIdx: number) => {
    // External drop (e.g. from standalone): source group not in this project
    const isExternal = !groups.some(g => g.id === sourceGroupId);
    if (isExternal && onAcceptTopicDrop) {
      // paneId from standalone is a topicId directly; from project tab bar is "chat:<topicId>"
      const topicId = paneId.startsWith('chat:') ? paneId.slice(5) : paneId;
      if (!topicIds.includes(topicId)) {
        onAcceptTopicDrop(topicId);
      }
      return;
    }

    setGroups(prev => {
      const sourceGroup = prev.find(g => g.id === sourceGroupId);
      const targetGroup = prev.find(g => g.id === targetGroupId);
      if (!sourceGroup || !targetGroup) return prev;
      if (!sourceGroup.paneIds.includes(paneId)) return prev;

      return prev.map(g => {
        if (g.id === sourceGroupId) {
          const remaining = g.paneIds.filter(id => id !== paneId);
          if (remaining.length === 0) return g; // will be cleaned by sync
          const newActive = g.activePaneId === paneId
            ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
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
  }, [groups, onAcceptTopicDrop, topicIds]);

  // Split a group by dropping a pane on an edge (creates new row or column)
  const handleSplitGroup = useCallback((sourceGroupId: string, paneId: string, targetGroupId: string, edge: 'left' | 'right' | 'top' | 'bottom') => {
    // Create a new group containing just the dragged pane
    const pane = panes.find(p => p.id === paneId);
    if (!pane) return;

    const newGroupId = createGroupId();
    const newGroup: PaneGroup = {
      id: newGroupId,
      paneIds: [paneId],
      activePaneId: paneId,
      type: paneTypeToGroupType(pane.type),
    };

    // Remove pane from source group
    setGroups(prev => {
      const updated = prev.map(g => {
        if (g.id === sourceGroupId) {
          const remaining = g.paneIds.filter(id => id !== paneId);
          if (remaining.length === 0) return g;
          const newActive = g.activePaneId === paneId
            ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
            : g.activePaneId;
          return { ...g, paneIds: remaining, activePaneId: newActive };
        }
        return g;
      }).filter(g => g.paneIds.length > 0);

      return [...updated, newGroup];
    });

    // Update rows to place the new group
    setRows(prev => {
      if (edge === 'left' || edge === 'right') {
        // Insert new group in the same row as target, left or right of it
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
        // top/bottom: create a new row above or below the row containing the target
        const targetRowIdx = prev.findIndex(row => row.groupIds.includes(targetGroupId));
        if (targetRowIdx === -1) return prev;

        const newRow = { groupIds: [newGroupId], widths: [1] };
        const newRows = [...prev];
        const insertAt = edge === 'top' ? targetRowIdx : targetRowIdx + 1;
        newRows.splice(insertAt, 0, newRow);
        return newRows;
      }
    });

    setFocusedGroupId(newGroupId);
  }, [panes]);

  // Reorder rows within the group layout
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

  // Available types for the "+" menu, based on group type
  const availableTypesForGroup = useCallback((groupType: PaneGroupType): PaneType[] => {
    const types: PaneType[] = ['browser', 'terminal', 'git', 'activity', 'journal', 'agents'];
    if (groupType === 'file') {
      types.unshift('files');
    }
    return types.filter(t => {
      const config = PANE_CONFIG[t];
      if (config.singleton && panes.some(p => p.type === t)) return false;
      return true;
    });
  }, [panes]);

  // Right-click menu: Settings opens TopicSettingsModal (resolve paneId → topicId)
  const handlePaneSettings = useCallback((paneId: string) => {
    const pane = panes.find(p => p.id === paneId);
    if (pane?.topicId) setSettingsTopicId(pane.topicId);
  }, [panes]);

  // Right-click menu: Pop Out opens chat topic in new window
  const handlePanePopOut = useCallback((paneId: string) => {
    const pane = panes.find(p => p.id === paneId);
    if (!pane?.topicId) return;
    const url = `${window.location.origin}?topic=${pane.topicId}`;
    isNativeApp
      ? window.open(url, `topic-${pane.topicId}`, 'width=900,height=700')
      : window.open(url, `topic-${pane.topicId}`);
    onClosePanel(pane.topicId);
  }, [panes, onClosePanel]);

  // First topicId for sidebar context
  const primaryTopicId = topicIds[0];

  const renderPane = useCallback((pane: Pane, isFocused: boolean) => {
    switch (pane.type) {
      case 'chat': {
        const topic = pane.topicId ? topics[pane.topicId] : null;
        if (!topic) return <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">Topic not found</div>;
        return (
          <ChatPane
            topic={topic}
            isFocused={isFocused && focusedPanelId === pane.topicId}
            getSessionMessages={getSessionMessages}
            isSessionLoading={isSessionLoading}
            isSessionStreaming={isSessionStreaming}
            sendMessage={sendMessage}
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
      case 'terminal':
        return (
          <Suspense fallback={LazySpinner}>
            <TerminalPanel projectPath={projectPath} />
          </Suspense>
        );
      case 'file':
        return pane.filePath ? (
          <Suspense fallback={LazySpinner}>
            <FilePane filePath={pane.filePath} projectPath={projectPath} />
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
      default:
        return null;
    }
  }, [
    topics, focusedPanelId, projectPath,
    getSessionMessages, isSessionLoading, isSessionStreaming,
    sendMessage, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
    handleOpenFile,
  ]);

  // Cross-panel-type drop: accept standalone chat drops
  const [panelDragOver, setPanelDragOver] = useState(false);

  const handleProjectDragOver = useCallback((e: React.DragEvent) => {
    if (!onAcceptTopicDrop) return;
    if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
    // Don't accept if it's a grid item drag (handled by PanelGrid)
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
    // Don't accept topics already in this project
    if (topicIds.includes(topicId)) return;
    e.preventDefault();
    e.stopPropagation();
    setPanelDragOver(false);
    onAcceptTopicDrop(topicId);
  }, [onAcceptTopicDrop, topicIds]);

  return (
    <div
      className={`flex flex-col min-h-0 min-w-[200px] overflow-hidden transition-all ${panelDragOver ? 'ring-2 ring-primary/50' : ''}`}
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

      {/* Main content: sidebar + group layout + context inspector */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        <ProjectSidebar
          projectPath={projectPath}
          topicId={primaryTopicId}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onOpenFile={handleOpenFile}
          onWSMessage={onWSMessage}
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
    </div>
  );
}
