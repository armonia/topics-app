import { createContext, useContext, useCallback, useMemo, useState, useEffect, type ReactNode } from 'react';
import type { UnreadData, WSMessage } from '../types';
import { useAttentionSignals, rollupProjectAttention, rollupGlobalAttention, topicAttentionCount, terminalAttentionCount, projectAttentionSubjects, describeProjectAttention } from '../state/signals';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { getTerminalSessionFromPaneId } from '../state/pane/adapters';
import { useRefMirror } from './useRefMirror';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';
import { useBoardTasks } from '../lib/boardTasksStore';
import { trayBoardGroups, trayBoardAttention } from '../../../shared/tray-board';

interface TabNotificationContextValue {
  /** Get badge count for a pane. Chat panes use unreadData[topicId], others use extraCounts. */
  getBadgeCount: (paneId: string, topicId?: string, isActive?: boolean) => number;
  /** Get the rolled-up badge count for a project tab (sum of its children). */
  getProjectBadgeCount: (projectPath: string) => number;
  /** CHI compone quel numero, in chiaro: «2 da guardare: Lavori aperti · build».
   *  Stringa vuota quando non c'è niente. Il numero di un progetto è un aggregato
   *  di figli che possono non avere una tab visibile (o averla, ma selezionata,
   *  che è il caso in cui la tab il numero non lo mostra): senza questo, un badge
   *  di progetto non è risalibile a nulla. */
  describeProjectBadge: (projectPath: string) => string;
  /** Increment badge for a non-chat pane (agents, terminal, etc.) */
  notifyPane: (paneId: string) => void;
  /** Clear badge for a non-chat pane */
  clearPane: (paneId: string) => void;
  /** Timestamps of last notification per topicId (for sidebar sort) */
  lastNotifiedAt: Map<string, number>;
  /** Raw badge counts for panes that are neither chat nor terminal.
   *  `getBadgeCount` reads it for the tab; the SIDEBAR needs it too, or a row
   *  hard-codes 0 while its own tab shows a number. */
  extraCounts: ReadonlyMap<string, number>;
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
  // Non-chat badge counts (terminal pane, etc.)
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

  useEffect(() => {
    return onWSMessage((msg) => {
      // Stream ended (a chat turn finished) → keep the topic's sidebar sort
      // position fresh. No pane badge: the chat's own unread rule owns that.
      if (msg.type === 'stream:end' && msg.topicId) {
        touchTopic(msg.topicId);
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
  }, [onWSMessage, notifyPane, touchTopic, focusedRef, openPanelsRef]);

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

  const describeProjectBadge = useCallback((projectPath: string): string => {
    return describeProjectAttention(
      projectAttentionSubjects(projectPath, topics, terminalSessions, unreadData, claudeAttentionTopics, terminalFinishedIds),
    );
  }, [topics, terminalSessions, unreadData, claudeAttentionTopics, terminalFinishedIds]);

  // Desktop (Tauri) dock-icon badge + macOS menu-bar tray glyph: reflect the
  // app-wide attention total on the OS chrome, driven by the SAME signals as the
  // in-app tab badges so it can never drift from what's on screen. The rollup
  // covers every topic + terminal; `extraCounts` adds the remaining pane badges
  // (which live only in this layer). No-op off Tauri.
  const totalAttention = useMemo(() => {
    let extra = 0;
    for (const n of extraCounts.values()) extra += n;
    return rollupGlobalAttention(topics, unreadData, claudeAttentionTopics, terminalFinishedIds) + extra;
  }, [topics, unreadData, claudeAttentionTopics, terminalFinishedIds, extraCounts]);
  // The top attention chats, as clickable tray-menu rows (id + title). Sorted by
  // attention weight, capped so the tray menu stays short. Only chat topics: they
  // navigate cleanly via handleTopicClick; terminal attention still counts
  // toward the badge but isn't a menu row.
  const attentionItems = useMemo(() => {
    return Object.values(topics)
      .map((t) => ({ id: t.id, title: t.name || t.id, n: topicAttentionCount(t.id, unreadData, claudeAttentionTopics) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 8)
      .map(({ id, title }) => ({ id, title }));
  }, [topics, unreadData, claudeAttentionTopics]);
  // IL LAVORO DELLA BOARD, nella stessa chiamata. La tray è l'unica superficie
  // che resta quando la finestra è nascosta, e diceva soltanto chi aspetta una
  // risposta in chat: dei task aperti, niente. Le righe arrivano dallo STESSO
  // store che alimenta la riga «Board» in sidebar (`boardTasksStore`), così le
  // due superfici non possono raccontare due board diverse; COSA entra nel menu
  // (ordine, esclusi, taglio dei titoli) lo decide `shared/tray-board`, dove è
  // provato — qui si legge e si spedisce, non si ridecide.
  const boardTasks = useBoardTasks();
  const boardGroups = useMemo(() => trayBoardGroups(boardTasks), [boardTasks]);
  // Il glifo conta anche le card che aspettano una DECISIONE. È lo stesso
  // criterio delle chat («chi sta chiedendo qualcosa a un umano»), quindi
  // finisce nello stesso numero: due contatori diversi su dock e barra dei menu
  // sarebbero la deriva che questo punto esiste per impedire. Il lavoro che
  // gira da solo non entra: non chiede niente a nessuno.
  const chromeCount = totalAttention + trayBoardAttention(boardGroups);
  useEffect(() => {
    if (!isTauri) return;
    void tauriInvoke('set_app_status', {
      count: chromeCount,
      items: attentionItems,
      groups: boardGroups,
    }).catch(() => {});
  }, [chromeCount, attentionItems, boardGroups]);

  // PWA / browser app badge (the Badging API — navigator.setAppBadge). This is
  // the SILENT channel: a muted topic emits no banner (useCompletionNotifier
  // gates that), but its completion still counts here — the rollup is mute-blind
  // — so an installed PWA shows "3 turns finished" on its dock/taskbar icon
  // without interrupting. Driven by the SAME `totalAttention` as the tab badges,
  // so it can never drift from what's on screen; it clears the moment a topic
  // returns to the foreground (reading a topic zeroes its unread → the rollup
  // drops). Feature-detected: no-op where the API is absent (Firefox, older
  // Safari). Runs on EVERY shell — the Badging API also lights the Tauri app
  // icon on platforms that support it, complementing the native tray glyph.
  //
  // STESSO NUMERO del glifo nativo (`chromeCount`), non `totalAttention`: sono
  // due strade che dipingono LA STESSA icona (su macOS il dock la riceve da
  // entrambe), e da quando le card in review contano, tenerle su due conti
  // diversi voleva dire un badge che cambia valore a seconda di chi l'ha
  // scritto per ultimo. Il criterio è uno: quante cose stanno chiedendo
  // qualcosa a un umano.
  useEffect(() => {
    const nav = typeof navigator !== 'undefined'
      ? (navigator as Navigator & {
          setAppBadge?: (n?: number) => Promise<void>;
          clearAppBadge?: () => Promise<void>;
        })
      : null;
    if (!nav?.setAppBadge) return;
    try {
      if (chromeCount > 0) void nav.setAppBadge(chromeCount).catch(() => {});
      else void nav.clearAppBadge?.().catch(() => {});
    } catch { /* Badging API can throw synchronously in locked-down webviews */ }
  }, [chromeCount]);

  const value = useMemo((): TabNotificationContextValue => ({
    getBadgeCount,
    getProjectBadgeCount,
    describeProjectBadge,
    notifyPane,
    clearPane,
    lastNotifiedAt,
    extraCounts,
    touchTopic,
  }), [getBadgeCount, getProjectBadgeCount, describeProjectBadge, notifyPane, clearPane, lastNotifiedAt, extraCounts, touchTopic]);

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
      describeProjectBadge: () => '',
      notifyPane: () => {},
      clearPane: () => {},
      lastNotifiedAt: new Map(),
      extraCounts: new Map(),
      touchTopic: () => {},
    };
  }
  return ctx;
}
