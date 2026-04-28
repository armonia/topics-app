import { createContext, useContext, useCallback, useRef, useMemo, useState, useEffect, type ReactNode } from 'react';
import type { UnreadData, WSMessage } from '../types';

interface TabNotificationContextValue {
  /** Get badge count for a pane. Chat panes use unreadData[topicId], others use extraCounts. */
  getBadgeCount: (paneId: string, topicId?: string, isActive?: boolean) => number;
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
          for (const panelId of openPanelsRef.current) {
            if (panelId.startsWith('agents') && panelId !== focusedRef.current) {
              notifyPane(panelId);
            }
          }
        }
      }
      // Approval request → badge on agents panes
      if (msg.type === 'approval:created') {
        for (const panelId of openPanelsRef.current) {
          if (panelId.startsWith('agents') && panelId !== focusedRef.current) {
            notifyPane(panelId);
          }
        }
      }
      // Stream ended (Claude finished responding) → badge on agents panes
      if (msg.type === 'stream:end' && msg.sessionKey) {
        for (const panelId of openPanelsRef.current) {
          if (panelId.startsWith('agents') && panelId !== focusedRef.current) {
            notifyPane(panelId);
          }
        }
        if (msg.topicId) {
          touchTopic(msg.topicId);
        }
      }
      // Chat message unread → touch topic for sidebar sort
      if (msg.type === 'unread:updated' && msg.topicId && msg.unreadCount > 0) {
        touchTopic(msg.topicId);
      }
    });
  }, [onWSMessage, notifyPane, touchTopic]);

  const getBadgeCount = useCallback((paneId: string, topicId?: string, isActive?: boolean): number => {
    if (isActive) return 0;
    // Chat panes: use existing unreadData
    if (topicId) {
      return unreadData[topicId]?.unreadCount || 0;
    }
    // Non-chat panes: use extraCounts
    return extraCounts.get(paneId) || 0;
  }, [extraCounts, unreadData]);

  const value = useMemo((): TabNotificationContextValue => ({
    getBadgeCount,
    notifyPane,
    clearPane,
    lastNotifiedAt,
    touchTopic,
  }), [getBadgeCount, notifyPane, clearPane, lastNotifiedAt, touchTopic]);

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
      notifyPane: () => {},
      clearPane: () => {},
      lastNotifiedAt: new Map(),
      touchTopic: () => {},
    };
  }
  return ctx;
}
