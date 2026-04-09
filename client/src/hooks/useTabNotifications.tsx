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

  useEffect(() => {
    return onWSMessage((msg: WSMessage) => {
      // Agent session completed/errored → badge on agents panes
      if (msg.type === 'agents:sessions' && Array.isArray((msg as any).sessions)) {
        for (const session of (msg as any).sessions as Array<{ status: string; topicId?: string; updatedAt?: number }>) {
          if (session.status === 'completed' || session.status === 'error') {
            const age = Date.now() - (session.updatedAt || 0);
            if (age < 60_000) {
              for (const panelId of openPanelsRef.current) {
                if (panelId.startsWith('agents') && panelId !== focusedRef.current) {
                  notifyPane(panelId);
                }
              }
              if (session.topicId) {
                touchTopic(session.topicId);
              }
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
      // Chat message unread → touch topic for sidebar sort
      if (msg.type === 'unread:updated' && (msg as any).topicId && (msg as any).unreadCount > 0) {
        touchTopic((msg as any).topicId as string);
      }
    });
  }, [onWSMessage, notifyPane, touchTopic]);

  const getBadgeCount = useCallback((paneId: string, topicId?: string, isActive?: boolean): number => {
    if (isActive) return 0;
    // Chat panes: use existing unreadData
    if (topicId) {
      return unreadRef.current[topicId]?.unreadCount || 0;
    }
    // Non-chat panes: use extraCounts
    return extraCounts.get(paneId) || 0;
  }, [extraCounts]);

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
