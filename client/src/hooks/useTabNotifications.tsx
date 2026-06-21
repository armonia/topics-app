import { createContext, useContext, useCallback, useRef, useMemo, useState, useEffect, type ReactNode } from 'react';
import type { UnreadData, WSMessage } from '../types';
import { useAttentionSignals, rollupProjectAttention, topicAttentionCount, terminalAttentionCount } from '../state/signals';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { getTerminalSessionFromPaneId } from '../state/pane/adapters';
import { useRefMirror } from './useRefMirror';

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

  // WS handlers for agent completion, approval requests, and chat unread updates.
  // Mirror open-panels + focus into refs so the long-lived WS handler closure
  // (registered once in the effect below) always reads the latest values
  // without re-subscribing on every render.
  const openPanelsRef = useRefMirror(openPanels);
  const focusedRef = useRefMirror(focusedPanelId);
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
    // openPanelsRef + focusedRef are stable ref objects (from useRefMirror);
    // listing them keeps badgePrefixes' identity stable while satisfying
    // exhaustive-deps. notifyPane is the only behavioural dependency.
  }, [notifyPane, openPanelsRef, focusedRef]);

  useEffect(() => {
    return onWSMessage((msg) => {
      // Agent session status changes → detect completion (active→idle) or error
      if (msg.type === 'agents:sessions') {
        const sessions = msg.sessions;
        const prevStatuses = prevSessionStatusRef.current;
        // The FIRST frame after load/reconnect is a baseline, not a set of
        // transitions: the roster watcher re-broadcasts the full list (which can
        // carry an hours-old `error` row), and we have no prior status to diff
        // against. Seeding-only on the first frame stops that stale row reading
        // as a fresh active→error and badging "a caso" on load. A genuinely-new
        // error in a LATER frame still requires a KNOWN non-error predecessor,
        // so a roster rebroadcast that first reveals an already-errored session
        // never notifies either.
        const isFirstFrame = prevStatuses.size === 0;
        let shouldNotifyAgents = false;

        for (const session of sessions) {
          const prevStatus = prevStatuses.get(session.key);
          // Notify on: active→idle (just completed) or a transition INTO error
          // from a known non-error status (symmetric with justCompleted).
          const justCompleted = prevStatus === 'active' && session.status === 'idle';
          const isError = prevStatus !== undefined && prevStatus !== 'error' && session.status === 'error';
          if (!isFirstFrame && (justCompleted || isError)) {
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
      // Stream ended (a chat turn finished) → badge ONLY the session-viewer
      // pinned to THIS session, if it's open and not focused. The old code
      // badged EVERY agents + session-viewer pane on every chat turn end
      // (badgePrefixes is sessionKey-blind) — "notifiche a caso" that piled up
      // on unrelated panes while you worked in chats. The agents-list pane gets
      // its real attention from the agents:sessions completion/error path above,
      // not from a chat stream ending, so it's no longer badged here.
      if (msg.type === 'stream:end' && msg.sessionKey) {
        const viewerId = `session-viewer:${msg.sessionKey}`;
        if (viewerId !== focusedRef.current && openPanelsRef.current.includes(viewerId)) {
          notifyPane(viewerId);
        }
        if (msg.topicId) {
          touchTopic(msg.topicId);
        }
      }
      // Agent explicitly asking for human help → badge agents panes
      if (msg.type === 'agent:escalation' || msg.type === 'agent:nudge') {
        badgePrefixes(AGENTS_PREFIXES);
      }
      // NB: `terminal:sessions` is intentionally NOT badged. It fires on every
      // session create/exit/roster refresh (e.g. opening any terminal tab), and
      // a terminal pane's badge is driven by the finished-turn signal
      // (terminalAttentionCount) — getBadgeCount short-circuits `terminal:` panes
      // to that and never reads extraCounts — so badging here lit nothing while
      // implying every open/close was attention. A finished claude-code turn
      // already badges via terminalFinishedIds.
      // Intentionally NOT badged: `git:status` and `dashboard:updated`. Both
      // fire from fswatch/heartbeat polling and would light up tabs while the
      // user is typing into their own editor. Re-enable behind a source-of-
      // change attribution when we have one.
      // Chat message unread → touch topic for sidebar sort
      if (msg.type === 'unread:updated' && msg.topicId && msg.unreadCount > 0) {
        touchTopic(msg.topicId);
      }
    });
    // focusedRef / openPanelsRef are stable useRefMirror objects (read via
    // .current inside), so listing them is behaviorally a no-op — it just
    // satisfies exhaustive-deps, matching the notifyPane effect above which
    // already lists them.
  }, [onWSMessage, notifyPane, touchTopic, badgePrefixes, focusedRef, openPanelsRef]);

  const getBadgeCount = useCallback((paneId: string, topicId?: string, isActive?: boolean): number => {
    // Claude "needs you" attention (approval / finished reply / error) persists
    // even while the tab is active — it clears only when the user interacts and
    // the session leaves the notable phase. Unread, by contrast, clears on focus.
    const claudeAttention = topicId && claudeAttentionTopics.has(topicId) ? 1 : 0;
    if (isActive) return claudeAttention;
    // Chat panes: max of server unread and Claude attention (don't double count)
    if (topicId) {
      return topicAttentionCount(topicId, unreadData, claudeAttentionTopics);
    }
    // claude-code terminal panes: a finished turn badges until the user opens it.
    if (paneId.startsWith('terminal:')) {
      const sid = getTerminalSessionFromPaneId(paneId);
      if (sid) return terminalAttentionCount(sid, terminalFinishedIds);
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

// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Context Provider + consumer-hook colocation; splitting the hook out would break the single-source-of-truth pairing and gains nothing at runtime
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
