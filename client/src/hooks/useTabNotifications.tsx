import { createContext, useContext, useCallback, useRef, useMemo, useState, useEffect, type ReactNode } from 'react';
import type { UnreadData, WSMessage } from '../types';
import { useAttentionSignals, rollupProjectAttention } from '../state/signals';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { getTerminalSessionFromPaneId } from '../state/pane/adapters';

interface TabNotificationContextValue {
  /** Get badge count for a pane. Chat panes use unreadData[topicId], others use extraCounts. */
  getBadgeCount: (paneId: string, topicId?: string, isActive?: boolean) => number;
  /** Get the rolled-up badge count for a project tab (sum of its children). */
  getProjectBadgeCount: (projectPath: string) => number;
  /** Increment badge for a non-chat pane (agents, terminal, etc.) */
  notifyPane: (paneId: string) => void;
  /** Clear badge for a non-chat pane */
  clearPane: (paneId: string) => void;
  /** Timestamps of last notification per topicId (for sidebar sort) */
  lastNotifiedAt: Map<string, number>;
  /** Record that a topic just received a notification (for sidebar sort ordering) */
  touchTopic: (topicId: string) => void;
}

const TabNotificationContext = createContext<TabNotificationContextValue | null>(null);

/** Prefix lists for pane-id matching. Standalone-group utility panes use
 *  the `__type__` envelope (see UtilityPanel.UTILITY_PREFIX); project-group
 *  panes use the bare `type:` form (see createPaneId in paneConfig.ts).
 *  Both are valid in `openPanels` depending on which surface created the
 *  pane, so every badge rule needs to cover both spellings. */
const AGENTS_PREFIXES = ['__agents__', 'agents:', 'agents', 'session-viewer:'] as const;
const BOARD_PREFIXES = ['__all-boards__', '__board__', 'board:', 'all-boards'] as const;

export function TabNotificationProvider({
  children,
  unreadData,
  onWSMessage,
  openPanels,
  focusedPanelId,
}: {
  children: ReactNode;
  unreadData: UnreadData;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  openPanels: string[];
  focusedPanelId: string | null;
}) {
  // Non-chat badge counts (agents pane, terminal pane, etc.)
  const [extraCounts, setExtraCounts] = useState<Map<string, number>>(() => new Map());
  // Timestamps for sidebar sort ordering
  const [lastNotifiedAt, setLastNotifiedAt] = useState<Map<string, number>>(() => new Map());
  const unreadRef = useRef(unreadData);
  unreadRef.current = unreadData;
  // Attention signals (Claude needs-you + claude-code finished) — subscribed
  // here so getBadgeCount's identity changes when they shift, re-running the
  // badge maps downstream. Topics/terminals power the project rollup.
  const { claudeAttentionTopics, terminalFinishedIds } = useAttentionSignals();
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();

  const notifyPane = useCallback((paneId: string) => {
    setExtraCounts(prev => {
      const next = new Map(prev);
      next.set(paneId, (prev.get(paneId) || 0) + 1);
      return next;
    });
  }, []);

  const clearPane = useCallback((paneId: string) => {
    setExtraCounts(prev => {
      if (!prev.has(paneId)) return prev;
      const next = new Map(prev);
      next.delete(paneId);
      return next;
    });
  }, []);

  const touchTopic = useCallback((topicId: string) => {
    setLastNotifiedAt(prev => {
      const next = new Map(prev);
      next.set(topicId, Date.now());
      return next;
    });
  }, []);

  // WS handlers for agent completion, approval requests, and chat unread updates
  const openPanelsRef = useRef(openPanels);
  openPanelsRef.current = openPanels;
  const focusedRef = useRef(focusedPanelId);
  focusedRef.current = focusedPanelId;
  // Track previous session statuses to detect active→idle transitions (= session completed)
  const prevSessionStatusRef = useRef<Map<string, string>>(new Map());

  // Helper: badge every open pane whose id matches one of the given prefixes,
  // skipping the currently focused pane. Centralised so each WS handler is a
  // one-liner and we don't drift on the focused-pane suppression rule.
  const badgePrefixes = useCallback((prefixes: readonly string[]) => {
    for (const panelId of openPanelsRef.current) {
      if (panelId === focusedRef.current) continue;
      for (const prefix of prefixes) {
        if (panelId.startsWith(prefix)) {
          notifyPane(panelId);
          break;
        }
      }
    }
  }, [notifyPane]);

  useEffect(() => {
    return onWSMessage((msg) => {
      // Agent session status changes → detect completion (active→idle) or error
      if (msg.type === 'agents:sessions') {
        const sessions = msg.sessions;
        const prevStatuses = prevSessionStatusRef.current;
        let shouldNotifyAgents = false;

        for (const session of sessions) {
          const prevStatus = prevStatuses.get(session.key);
          // Notify on: active→idle transition (session just completed), or error status
          const justCompleted = prevStatus === 'active' && session.status === 'idle';
          const isError = session.status === 'error' && prevStatus !== 'error';
          if (justCompleted || isError) {
            shouldNotifyAgents = true;
            if (session.topicId) {
              touchTopic(session.topicId);
            }
          }
        }

        // Update tracked statuses
        const newStatuses = new Map<string, string>();
        for (const session of sessions) {
          newStatuses.set(session.key, session.status);
        }
        prevSessionStatusRef.current = newStatuses;

        if (shouldNotifyAgents) {
          badgePrefixes(AGENTS_PREFIXES);
        }
      }
      // Approval request → badge on agents + board panes (board surfaces
      // approval-needing tasks too)
      if (msg.type === 'approval:created') {
        badgePrefixes([...AGENTS_PREFIXES, ...BOARD_PREFIXES]);
      }
      // Stream ended (Claude finished responding) → badge on agents + session-viewer
      if (msg.type === 'stream:end' && msg.sessionKey) {
        badgePrefixes(AGENTS_PREFIXES);
        if (msg.topicId) {
          touchTopic(msg.topicId);
        }
      }
      // Agent explicitly asking for human help → badge agents + board panes
      if (msg.type === 'agent:escalation' || msg.type === 'agent:nudge') {
        badgePrefixes([...AGENTS_PREFIXES, ...BOARD_PREFIXES]);
      }
      // Board activity from autonomous workers → badge board tabs
      if (msg.type === 'task:created' || msg.type === 'task:moved' || msg.type === 'task:unarchived') {
        badgePrefixes(BOARD_PREFIXES);
      }
      // Board memory updates → badge board-memory tabs
      if (msg.type === 'board-memory:created' || msg.type === 'board:memory_added') {
        badgePrefixes([...BOARD_PREFIXES, 'board-memory:']);
      }
      // New terminal session spawned externally → badge terminal panes
      // (edge-triggered: server broadcasts on session create/exit, not poll)
      if (msg.type === 'terminal:sessions') {
        badgePrefixes(['terminal:']);
      }
      // Intentionally NOT badged: `git:status` and `dashboard:updated`. Both
      // fire from fswatch/heartbeat polling and would light up tabs while the
      // user is typing into their own editor. Re-enable behind a source-of-
      // change attribution when we have one.
      // Chat message unread → touch topic for sidebar sort
      if (msg.type === 'unread:updated' && msg.topicId && msg.unreadCount > 0) {
        touchTopic(msg.topicId);
      }
    });
  }, [onWSMessage, notifyPane, touchTopic, badgePrefixes]);

  const getBadgeCount = useCallback((paneId: string, topicId?: string, isActive?: boolean): number => {
    // Claude "needs you" attention (approval / finished reply / error) persists
    // even while the tab is active — it clears only when the user interacts and
    // the session leaves the notable phase. Unread, by contrast, clears on focus.
    const claudeAttention = topicId && claudeAttentionTopics.has(topicId) ? 1 : 0;
    if (isActive) return claudeAttention;
    // Chat panes: max of server unread and Claude attention (don't double count)
    if (topicId) {
      return Math.max(unreadData[topicId]?.unreadCount || 0, claudeAttention);
    }
    // claude-code terminal panes: a finished turn badges until the user opens it.
    if (paneId.startsWith('terminal:')) {
      const sid = getTerminalSessionFromPaneId(paneId);
      if (sid && terminalFinishedIds.has(sid)) return 1;
    }
    // Other non-chat panes: use extraCounts
    return extraCounts.get(paneId) || 0;
  }, [extraCounts, unreadData, claudeAttentionTopics, terminalFinishedIds]);

  // Project tab badge = rollup of every child's attention, computed centrally
  // (no per-window report-up). Children belong to a project via topic.projectPath
  // or terminal cwd.
  const getProjectBadgeCount = useCallback((projectPath: string): number => {
    return rollupProjectAttention(projectPath, topics, terminalSessions, unreadData, claudeAttentionTopics, terminalFinishedIds);
  }, [topics, terminalSessions, unreadData, claudeAttentionTopics, terminalFinishedIds]);

  const value = useMemo((): TabNotificationContextValue => ({
    getBadgeCount,
    getProjectBadgeCount,
    notifyPane,
    clearPane,
    lastNotifiedAt,
    touchTopic,
  }), [getBadgeCount, getProjectBadgeCount, notifyPane, clearPane, lastNotifiedAt, touchTopic]);

  return (
    <TabNotificationContext.Provider value={value}>
      {children}
    </TabNotificationContext.Provider>
  );
}

export function useTabNotifications(): TabNotificationContextValue {
  const ctx = useContext(TabNotificationContext);
  if (!ctx) {
    // Fallback for components outside provider — return no-op
    return {
      getBadgeCount: () => 0,
      getProjectBadgeCount: () => 0,
      notifyPane: () => {},
      clearPane: () => {},
      lastNotifiedAt: new Map(),
      touchTopic: () => {},
    };
  }
  return ctx;
}
