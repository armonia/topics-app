import { Suspense, createContext, lazy, useContext, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import { attentionOf, useAttentionRows, useAttentionStore } from '../state/attention';
import { boardLitCards, describeProjectAttention, projectAttention, projectAttentionChildren } from '../state/attentionRollups';
import { chromeAttentionSubjects, notificationsToWithdraw, trayChatItems, type ChromeSubject } from '../state/attentionTotal';
import { useTopics, useTerminalSessions } from '../contexts/TopicsContext';
import { getTerminalSessionFromPaneId } from '../state/pane/adapters';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';
import { useBoardTasks } from '../lib/boardTasksStore';
import { trayBoardGroups, trayAgentStates } from '../../../shared/tray-board';
import { isMainWindow } from '../lib/windowRole';
import { useT } from './useT';
import { estimatesByProject } from '../../../shared/task-countdown';
import { workLine } from '../lib/workLine';
import { useMachinesOverview } from './useMachinesOverview';
import { trayMachines } from '../lib/trayMachines';
import { terminalSubject, topicSubject } from '../../../shared/attention';
import { useDominantAction } from '../state/agentActionHooks';
import { inboxModel, type InboxModel } from '../lib/inboxModel';
import { NO_HUB, bellGroups, bellTone, bellTotal, type BellGroup, type BellTone } from '../lib/bellGroups';
import { useBellHubPart, type BellHubPart } from '../state/bellHubPart';

/** The hub's part of the ledger runs in its own chunk: its parsers are not needed to paint the first frame. */
const BellHubSource = lazy(() => import('./BellHubSource'));

/**
 * THE BELL'S LEDGER: the rows of «Ora» and their total, computed once for the
 * window. The Dock, the tray, the PWA badge, the bell's button and its «Ora»
 * tab all read this, so they cannot say different numbers.
 */
export interface BellLedger {
  model: InboxModel;
  groups: BellGroup[];
  total: number;
  tone: BellTone;
  /** How many rows ask for an answer («Decidi tu»): the button's name says it. */
  decide: number;
  hub: Omit<BellHubPart, 'hub'>;
}

const NO_LEDGER: BellLedger = {
  model: { waiting: [], finished: [], working: [] }, groups: [], total: 0, tone: 'quiet', decide: 0,
  hub: { present: false, answering: false, downSince: null, unread: [], jarvis: null },
};

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
  /** The lit subjects of Topics: the Topics part of the bell's ledger. */
  attentionSubjects: readonly ChromeSubject[];
  /** THE one number (Dock, tray, PWA badge, the bell and its «Ora» tab) and the rows behind it. */
  bell: BellLedger;
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
  // nothing about open cards. What waits on a person comes from the lit `task:`
  // rows the glyph and the board tab count (`boardLitCards`, steps included),
  // grouped by why they wait; the work in progress and the queue come from the
  // feed (`boardTasksStore`), the store of the "Board" sidebar row. WHAT enters
  // the menu (order, exclusions, title cut) is decided and tested in
  // `shared/tray-board`. Here it is read and shipped.
  const boardTasks = useBoardTasks();
  const boardGroups = useMemo(() => {
    // The same countdown the cards draw, from the same history of closed cards.
    const estimates = estimatesByProject(boardTasks);
    return trayBoardGroups(boardTasks, {
      lit: boardLitCards(attention, boardTasks, null).map((c) => ({ id: c.id, title: c.title, projectId: c.projectId ?? '', reason: c.reason })),
      runningSuffix: (t) => workLine(tr, {
        basis: estimates.get(t.projectId), elapsedMs: t.agentMs ?? 0, stepsDone: t.subtaskDoneCount, stepsTotal: t.subtaskCount,
      }),
    });
  }, [boardTasks, attention, tr]);
  // The agents by state, for the strip's left group: counted from the same rows.
  const agentStatesKey = useMemo(() => {
    const subjects = { working: 0, needsYou: 0, error: 0 };
    for (const key of attention.keys()) {
      const a = attentionOf(attention, key);
      if (a.tier === 'working') subjects.working += 1;
      else if (a.lit && !key.startsWith('task:')) {
        if (a.tier === 'needs-you') subjects.needsYou += 1;
        else if (a.tier === 'error') subjects.error += 1;
      }
    }
    return JSON.stringify(trayAgentStates(boardGroups, subjects));
  }, [attention, boardGroups]);
  // THE LIT SUBJECTS (ATTN-08, CHROME-COUNT-01): an archived chat never, no
  // history row, nothing window-local. They are the Topics part of the ledger
  // below, whose total the Dock, the tray, the PWA badge and the bell paint.
  const attentionSubjects = useMemo(() => chromeAttentionSubjects(attention, topics, terminalSessions), [attention, topics, terminalSessions]);
  // THE LEDGER: the Topics subjects above plus what the hub asks of the person,
  // as the rows of «Ora». Its total is the number every surface paints. The
  // hub's part comes from `BellHubSource` (rendered below, lazy); before it
  // lands the ledger is the Topics rows, as while the hub has not answered.
  const hubPart = useBellHubPart();
  const bell = useMemo((): BellLedger => {
    const model = inboxModel(attention, topics, terminalSessions, boardTasks);
    const groups = bellGroups(model, hubPart?.hub ?? NO_HUB);
    return {
      model, groups, total: bellTotal(groups), tone: bellTone(groups),
      decide: groups.find((g) => g.key === 'decide')?.entries.length ?? 0,
      hub: hubPart
        ? { present: hubPart.present, answering: hubPart.answering, downSince: hubPart.downSince, unread: hubPart.unread, jarvis: hubPart.jarvis }
        : NO_LEDGER.hub,
    };
  }, [attention, topics, terminalSessions, boardTasks, hubPart]);
  const chromeCount = bell.total;
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
  // Not before `attention:init`: the empty store of a reload wrote 0, then N, and the Dock flashed.
  const attentionReady = useAttentionStore((s) => s.ready);
  // Every machine Topics knows, as submenus of the tray. Only the hand that writes the tray reads them.
  const overview = useMachinesOverview(writesTheDock);
  const machinesKey = useMemo(() => JSON.stringify(trayMachines(overview?.machines ?? [], tr)), [overview, tr]);
  // What the agents at work are doing, the latest move (steadied by the dwell
  // rule): the tray's working glyph will draw it. Absent when nothing works.
  const action = useDominantAction();
  useEffect(() => {
    if (!writesTheDock || !attentionReady) return;
    void tauriInvoke('set_app_status', {
      count: chromeCount,
      items: attentionItems,
      groups: boardGroups,
      machines: JSON.parse(machinesKey),
      agents: JSON.parse(agentStatesKey),
      ...(action ? { action } : {}),
    }).catch(() => {});
  }, [writesTheDock, attentionReady, chromeCount, attentionItems, boardGroups, machinesKey, agentStatesKey, action]);

  // PWA / browser app badge (the Badging API, navigator.setAppBadge): the same
  // number. Not under Tauri, where the shell's dock badge is the one writer.
  // Feature-detected: no-op where the API is absent.
  useEffect(() => {
    if (isTauri || !attentionReady) return;
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
  }, [attentionReady, chromeCount]);

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
    attentionSubjects,
    bell,
  }), [getBadgeCount, getProjectBadgeCount, describeProjectBadge, attentionSubjects, bell]);

  return (
    <TabNotificationContext.Provider value={value}>
      {children}
      <Suspense fallback={null}><BellHubSource /></Suspense>
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
      attentionSubjects: [],
      bell: NO_LEDGER,
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
