import { createContext, useContext, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import { attentionOf, useAttentionRows, useAttentionStore } from '../state/attention';
import { describeProjectAttention, projectAttention, projectAttentionChildren } from '../state/attentionRollups';
import { chromeAttentionSubjects, notificationsToWithdraw, trayChatItems, type ChromeSubject } from '../state/attentionTotal';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { getTerminalSessionFromPaneId } from '../state/pane/adapters';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';
import { useBoardTasks } from '../lib/boardTasksStore';
import { trayBoardGroups } from '../../../shared/tray-board';
import { isMainWindow } from '../lib/windowRole';
import { useT } from './useT';
import { terminalSubject, topicSubject } from '../../../shared/attention';

interface TabNotificationContextValue {
  /** The number on a pane's tab: `max(1, unread)` of a lit chat or terminal,
   *  0 for anything else (TAB-BADGE-01, PARITY-01). The active tab of the
   *  focused pane shows no number (TAB-BADGE-07): `isActive`. */
  getBadgeCount: (paneId: string, topicId?: string, isActive?: boolean) => number;
  /** The number on a project tab: its lit children. */
  getProjectBadgeCount: (projectPath: string) => number;
  /** WHO makes that number, in words: «2 to look at: Render · build». Empty
   *  when nothing is lit. */
  describeProjectBadge: (projectPath: string) => string;
  /** THE one number (Dock, tray, PWA badge, inbox) and the subjects behind it. */
  attentionTotal: number;
  attentionSubjects: readonly ChromeSubject[];
}

const TabNotificationContext = createContext<TabNotificationContextValue | null>(null);

export function TabNotificationProvider({ children }: { children: ReactNode }) {
  const tr = useT();
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();
  const attention = useAttentionRows();

  const getBadgeCount = useCallback((paneId: string, topicId?: string, isActive?: boolean): number => {
    if (isActive) return 0;
    if (topicId) return attentionOf(attention, topicSubject(topicId)).count;
    const sid = paneId.startsWith('terminal:') ? getTerminalSessionFromPaneId(paneId) : null;
    if (sid) return attentionOf(attention, terminalSubject(sid)).count;
    return 0;
  }, [attention]);

  // Project tab badge = its lit children, computed centrally (no per-window
  // report-up). Children belong to a project via topic.projectPath or
  // terminal cwd: the same walk the sidebar's project row does.
  const getProjectBadgeCount = useCallback(
    (projectPath: string): number => projectAttention(attention, projectPath, topics, terminalSessions).count,
    [attention, topics, terminalSessions],
  );

  const describeProjectBadge = useCallback((projectPath: string): string => describeProjectAttention(
    projectAttentionChildren(attention, projectPath, topics, terminalSessions),
    { lookAt: (n) => tr('attention.project.lookAt', { n }), more: (n) => tr('attention.project.more', { n }) },
  ), [attention, topics, terminalSessions, tr]);

  // THE BOARD'S WORK, in the same call. The tray is the only surface left when
  // the window is hidden, and it used to list only the chats waiting for a reply:
  // nothing about open cards. The rows come from the SAME store that feeds the
  // "Board" sidebar row (`boardTasksStore`), so the two surfaces cannot tell two
  // different boards; WHAT enters the menu (order, exclusions, title cut) is
  // decided and tested in `shared/tray-board`. Here it is read and shipped.
  const boardTasks = useBoardTasks();
  const boardGroups = useMemo(() => trayBoardGroups(boardTasks), [boardTasks]);
  // THE ONE OS NUMBER (ATTN-08, CHROME-COUNT-01): the lit subjects of the
  // attention state, an archived chat never. Dock badge, menu-bar tray glyph,
  // the PWA Badging API and the inbox's button all read `chromeCount`. No
  // history row enters it, and nothing window-local does.
  const attentionSubjects = useMemo(() => chromeAttentionSubjects(attention, topics, terminalSessions), [attention, topics, terminalSessions]);
  const chromeCount = attentionSubjects.length;
  // The chat and terminal rows of the tray menu, from the subjects the glyph
  // counts, so the menu lists what the number says.
  const attentionItems = useMemo(
    () => trayChatItems(attentionSubjects, attention, topics, terminalSessions),
    [attentionSubjects, attention, topics, terminalSessions],
  );
  // ONE HAND WRITES THE DOCK (ATTN-08, WIN-1): the main window. Every window
  // computes the same number from the same frames, but two writers made the
  // Dock and the tray take the value of whichever wrote last. The main window
  // hidden in the tray keeps computing and writing: its store receives the
  // same frames. The shell refuses the call from any other window too.
  const writesTheDock = useMemo(() => isTauri && isMainWindow(), []);
  useEffect(() => {
    if (!writesTheDock) return;
    void tauriInvoke('set_app_status', {
      count: chromeCount,
      items: attentionItems,
      groups: boardGroups,
    }).catch(() => {});
  }, [writesTheDock, chromeCount, attentionItems, boardGroups]);

  // PWA / browser app badge (the Badging API, navigator.setAppBadge): the same
  // number. Not under Tauri, where the shell's dock badge is the one writer.
  // Feature-detected: no-op where the API is absent.
  useEffect(() => {
    if (isTauri) return;
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

  // THE PHONE ALIGNS WHEN IT OPENS (ATTN-06, design section 6): a seen made on
  // the Mac while the PWA was closed left its delivered notifications on the
  // lock screen. At every `attention:init` (the open, every return to the
  // foreground: the socket reconnects) the page withdraws those whose subject
  // is no longer lit. iOS allows no silent push that would do it sooner.
  const ready = useAttentionStore((s) => s.ready);
  useEffect(() => {
    if (!ready || isTauri) return;
    void withdrawStaleNotifications(attention);
  }, [ready, attention]);

  const value = useMemo((): TabNotificationContextValue => ({
    getBadgeCount,
    getProjectBadgeCount,
    describeProjectBadge,
    attentionTotal: chromeCount,
    attentionSubjects,
  }), [getBadgeCount, getProjectBadgeCount, describeProjectBadge, chromeCount, attentionSubjects]);

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
      attentionTotal: 0,
      attentionSubjects: [],
    };
  }
  return ctx;
}

/**
 * Withdraws the delivered notifications whose subject is no longer lit, and
 * only those: the selector is `notificationsToWithdraw`, tested on its own.
 * Best-effort: no service worker, no permission, an API that throws, all mean
 * nothing to withdraw.
 */
async function withdrawStaleNotifications(rows: ReturnType<typeof useAttentionStore.getState>['rows']): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.getNotifications) return;
    for (const n of notificationsToWithdraw(await reg.getNotifications(), rows)) n.close();
  } catch { /* nothing delivered can be read here */ }
}
