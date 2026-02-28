import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PaneGroup, PaneGroupType, GroupLayoutRow } from '../../types';
import { ProjectHeader, getProjectName } from './ProjectHeader';
import { ProjectSidebar } from '../Project/ProjectSidebar';
import { GroupLayout } from './GroupLayout';
import { ChatPane } from '../Chat/ChatPane';
import { createPaneId, createGroupId, PANE_CONFIG } from '../../lib/paneConfig';
import { DND_TYPES } from '../../lib/dndTypes';
import { findPreviewPane, replacePaneInGroup } from '../../lib/previewTabs';
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
  onPendingPaneConsumed?: () => void;
  onNewChat?: () => void;
  // Navigate to a specific topic inside the project (from external focus)
  pendingFocusTopicId?: string | null;
  onPendingFocusConsumed?: () => void;
}

export function ProjectWindowPane({
  projectPath, topics, focusedPanelId,
  onFocusPanel, onClosePanel,
  getSessionMessages, isSessionLoading, isSessionStreaming, stopSession,
  sendMessage, editMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  pendingPane, onPendingPaneConsumed, onNewChat,
  pendingFocusTopicId, onPendingFocusConsumed,
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
  const [groups, setGroups] = useState<PaneGroup[]>(() => persisted.current?.groups || []);
  const pendingPreviewCloseRef = useRef<string | null>(null);
  // Track topic IDs manually closed by the user (so the sync effect doesn't re-add them)
  const closedTopicIdsRef = useRef<Set<string>>(new Set());
  const [rows, setRows] = useState<GroupLayoutRow[]>(() => persisted.current?.rows || []);
  const [rowHeights, setRowHeights] = useState<number[]>(() => persisted.current?.rowHeights || [1]);
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => persisted.current?.sidebarCollapsed ?? false);
  const [showContext, setShowContext] = useState(() => {
    try { return localStorage.getItem('topics-context-inspector-open') === 'true'; } catch { return false; }
  });
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);

  // Determine active topic for Context Inspector
  const focusedGroup = groups.find(g => g.id === focusedGroupId);
  const focusedPane = focusedGroup ? panes.find(p => p.id === focusedGroup.activePaneId) : null;
  const activeTopicId = focusedPane?.type === 'chat' ? focusedPane.topicId || null : null;
  const activeTopic = activeTopicId ? topics[activeTopicId] : null;
  const paneToTopicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of panes) {
      if (p.type === 'chat' && p.topicId) map[p.id] = p.topicId;
    }
    return map;
  }, [panes]);
  const contextPercent = useMultiContextPercent(paneToTopicMap);

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
          closedTopicIdsRef.current.add(pane.topicId);
          setPanes(prev => prev.filter(p => p.id !== paneId));
        }
      }
    }
  }, [panes, topics, stopSession]);

  useEffect(() => {
    try { localStorage.setItem('topics-context-inspector-open', String(showContext)); } catch {}
  }, [showContext]);

  // Persist non-chat panes, groups, rows
  useEffect(() => {
    const nonChatPanes = panes.filter(p => p.type !== 'chat' && !p.preview);
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
    // Clean up closedTopicIds for topics that no longer exist in the project
    const currentSet = new Set(topicIds);
    for (const id of closedTopicIdsRef.current) {
      if (!currentSet.has(id)) closedTopicIdsRef.current.delete(id);
    }

    setPanes(prev => {
      const chatPaneIds = new Set(prev.filter(p => p.type === 'chat').map(p => p.topicId));
      let updated = prev.filter(p => p.type !== 'chat' || (p.topicId && currentSet.has(p.topicId)));
      const newChatPanes: Pane[] = [];
      for (const tid of topicIds) {
        if (!chatPaneIds.has(tid) && !closedTopicIdsRef.current.has(tid)) {
          const topic = topics[tid];
          newChatPanes.push({
            id: createPaneId('chat', tid),
            type: 'chat' as PaneType,
            topicId: tid,
            title: topic?.name || 'Chat',
            preview: true,
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
      let updated = prev.map(g => {
        const filtered = g.paneIds.filter(id => allPaneIds.has(id));
        if (filtered.length === g.paneIds.length) return g;
        const activePaneId = filtered.includes(g.activePaneId)
          ? g.activePaneId
          : filtered[0] || g.activePaneId;
        return { ...g, paneIds: filtered, activePaneId };
      }).filter(g => g.paneIds.length > 0);

      const usedAfterClean = new Set(updated.flatMap(g => g.paneIds));
      const orphanPanes = panes.filter(p => !usedAfterClean.has(p.id));
      const orphansByType = new Map<PaneGroupType, Pane[]>();
      for (const p of orphanPanes) {
        const gt = paneTypeToGroupType(p.type);
        if (!orphansByType.has(gt)) orphansByType.set(gt, []);
        orphansByType.get(gt)!.push(p);
      }

      for (const [gt, orphans] of orphansByType) {
        // Always add orphans to an existing group — prefer same-type, then focused, then first.
        // Never create a new group automatically; only explicit user splits do that.
        const targetGroup = updated.find(g => g.type === gt)
          || (focusedGroupId ? updated.find(g => g.id === focusedGroupId) : null)
          || updated[0];

        if (targetGroup) {
          const previewOrphan = orphans.find(o => o.preview);
          if (previewOrphan) {
            const existingPreview = findPreviewPane(
              targetGroup.paneIds.map(id => panes.find(p => p.id === id)).filter((p): p is Pane => !!p && paneTypeToGroupType(p.type) === gt),
              previewOrphan.id
            );
            if (existingPreview) {
              targetGroup.paneIds = replacePaneInGroup(targetGroup.paneIds, existingPreview.id, previewOrphan.id);
              targetGroup.activePaneId = previewOrphan.id;
              const otherOrphans = orphans.filter(o => o !== previewOrphan);
              if (otherOrphans.length > 0) {
                targetGroup.paneIds = [...targetGroup.paneIds, ...otherOrphans.map(p => p.id)];
              }
              if (gt === 'chat' && existingPreview.topicId) {
                pendingPreviewCloseRef.current = existingPreview.topicId;
              }
              continue;
            }
          }
          targetGroup.paneIds = [...targetGroup.paneIds, ...orphans.map(p => p.id)];
        } else {
          // No groups at all — create the first one
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
      let newRows = prev.map(r => {
        const filtered = r.groupIds.filter(id => allGroupIds.has(id));
        if (filtered.length === r.groupIds.length) return r;
        const widths = filtered.map(() => 1 / filtered.length);
        return { groupIds: filtered, widths };
      }).filter(r => r.groupIds.length > 0);

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

  // Reopen a closed topic (remove from closedTopicIds so sync effect re-creates the pane)
  const reopenTopic = useCallback((topicId: string) => {
    if (closedTopicIdsRef.current.has(topicId)) {
      closedTopicIdsRef.current.delete(topicId);
      // Manually add the pane back since the sync effect may not re-run
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
    }
  }, [topics]);

  // Set focused group when focusedPanelId changes (external focus)
  useEffect(() => {
    if (focusedPanelId) {
      reopenTopic(focusedPanelId);
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
  }, [focusedPanelId, panes, groups, reopenTopic]);

  // Handle pending focus from external navigation (e.g. search → topic in project)
  useEffect(() => {
    if (pendingFocusTopicId) {
      reopenTopic(pendingFocusTopicId);
      const chatPane = panes.find(p => p.type === 'chat' && p.topicId === pendingFocusTopicId);
      if (chatPane) {
        const g = groups.find(g => g.paneIds.includes(chatPane.id));
        if (g) {
          setFocusedGroupId(g.id);
          setGroups(prev => prev.map(gg =>
            gg.id === g.id ? { ...gg, activePaneId: chatPane.id } : gg
          ));
        }
        // Consume only after successfully finding the pane
        onPendingFocusConsumed?.();
      }
      // If pane not found yet (just reopened via setPanes), effect will re-run
    }
  }, [pendingFocusTopicId, panes, groups, onPendingFocusConsumed, reopenTopic]);

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
    } else {
      // Non-chat pane (file, terminal, etc.) — focus the project itself
      onFocusPanel(createPaneId('project', projectPath));
    }
  }, [panes, onFocusPanel, projectPath]);

  const handleClosePane = useCallback((groupId: string, paneId: string) => {
    const pane = panes.find(p => p.id === paneId);

    if (pane?.type === 'chat' && pane.topicId) {
      // Track as manually closed so the sync effect doesn't re-add it
      closedTopicIdsRef.current.add(pane.topicId);
    }

    // Remove the pane from local state
    setPanes(prev => prev.filter(p => p.id !== paneId));

    setGroups(prev => {
      return prev.map(g => {
        if (g.id !== groupId) return g;
        const remaining = g.paneIds.filter(id => id !== paneId);
        if (remaining.length === 0) return g;
        const newActive = g.activePaneId === paneId
          ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
          : g.activePaneId;
        return { ...g, paneIds: remaining, activePaneId: newActive };
      }).filter(g => g.paneIds.length > 0);
    });
  }, [panes]);

  const handleAddPaneToGroup = useCallback((groupId: string, type: PaneType) => {
    const config = PANE_CONFIG[type];
    if (config.singleton) {
      const existing = panes.find(p => p.type === type);
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
    }

    const newPane: Pane = {
      id: createPaneId(type),
      type,
      title: PANE_CONFIG[type].label,
      preview: true,
    };

    const targetGroup = groups.find(g => g.id === groupId);
    const groupPanes = targetGroup?.paneIds.map(id => panes.find(p => p.id === id)).filter((p): p is Pane => !!p) || [];
    const existingPreview = findPreviewPane(groupPanes.filter(p => p.type === type), newPane.id);

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
  }, [panes, groups]);

  // Handle pending pane request from sidebar — always add to focused/first group
  useEffect(() => {
    if (pendingPane) {
      const targetGroupId = focusedGroupId || groups[0]?.id;
      if (targetGroupId) {
        handleAddPaneToGroup(targetGroupId, pendingPane);
      }
      onPendingPaneConsumed?.();
    }
  }, [pendingPane, groups, focusedGroupId, handleAddPaneToGroup, onPendingPaneConsumed]);

  const handleOpenFile = useCallback((path: string) => {
    const existing = panes.find(p => p.type === 'file' && p.filePath === path);
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

    const filename = path.split('/').pop() || path;
    const newPane: Pane = {
      id: createPaneId('file'),
      type: 'file',
      filePath: path,
      title: filename,
      preview: true,
    };

    // Add to focused group (or first group) — never create a new group for files
    const targetGroup = (focusedGroupId ? groups.find(g => g.id === focusedGroupId) : null) || groups[0];
    if (!targetGroup) {
      // No groups at all — add pane and let orphan sync create a group
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

  const handleOpenProcessLog = useCallback((processId: string, scriptName: string) => {
    const paneKey = `process-log:${processId}`;
    const existing = panes.find(p => p.id === paneKey);
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

    const newPane: Pane = {
      id: paneKey,
      type: 'process-log',
      processId,
      title: scriptName,
    };

    const targetGroup = (focusedGroupId ? groups.find(g => g.id === focusedGroupId) : null) || groups[0];
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
  }, [panes, groups, focusedGroupId]);

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
      // Mark as closed so the sync effect doesn't re-add the replaced preview
      closedTopicIdsRef.current.add(id);
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
          if (remaining.length === 0) return g;
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

  const availableTypesForGroup = useCallback((groupType: PaneGroupType): PaneType[] => {
    const types: PaneType[] = ['browser', 'terminal', 'git'];
    if (groupType === 'file') {
      types.unshift('files');
    }
    return types.filter(t => {
      const config = PANE_CONFIG[t];
      if (config.fixed) return false;
      if (config.singleton && panes.some(p => p.type === t)) return false;
      return true;
    });
  }, [panes]);

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
    closedTopicIdsRef.current.add(pane.topicId);
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
      case 'terminal':
        return (
          <Suspense fallback={LazySpinner}>
            <TerminalPanel projectPath={projectPath} />
          </Suspense>
        );
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
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        <ProjectSidebar
          projectPath={projectPath}
          topicId={primaryTopicId}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          onOpenFile={handleOpenFile}
          onWSMessage={onWSMessage}
          onOpenProcessLog={handleOpenProcessLog}
          onOpenBoard={() => {
            const targetGroupId = focusedGroupId || groups[0]?.id;
            if (targetGroupId) handleAddPaneToGroup(targetGroupId, 'board');
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
    </div>
  );
}
