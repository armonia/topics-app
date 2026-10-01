/**
 * ONE "SEEN" PER PANE: the window's focused pane, looked at for the dwell.
 *
 * Before, "seen" had one definition per surface and each one cleared its own
 * marks: the tab click cleared the terminal mark, the terminal body cleared it
 * as soon as it was merely visible (focused or not), the chat pane cleared the
 * chat mark on focus with no dwell, and three separate dwells (the active tab
 * of a focused group, the focused chat row, the focused terminal row) set the
 * flag the blue fill reads. A click INSIDE a pane went through none of the
 * tab's private clears, so the tab you had just clicked into stayed blue.
 *
 * Now there is one subject in front per window: the pane the window has
 * focused (`focusedPanelId`, or the focused inner pane of a focused project
 * window), whatever input put it there: a tab click, a click or tap inside the
 * pane, the keyboard, the palette, a sidebar row. When it has been in front,
 * with the window awake, for SEEN_DWELL_MS, ONE event (`seeSubject`) clears
 * every mark of it, and every surface reads those same marks: the tab, the
 * sidebar row, the project and group rollups, the bell and the Dock.
 *
 * A terminal's history rows (grouped under `terminal:<id>`) are one of those
 * marks on their own: a claude-code terminal driven by hooks never gets the
 * finished mark (its phase drives attention), so its banner's row is the only
 * thing it leaves on the bell, and the seen event has to clear it too.
 *
 * A pane can be in front with no focus to name it: with `focusedPanelId` null
 * (a new device, after a drop) the group draws its active tab as focused, so
 * the group holds that pane in front itself (`StandaloneChatGroup`). The board's
 * coordinator chat lives in a drawer inside the board pane, which has no
 * subject of its own: the drawer holds the coordinator (`SubjectInFront`).
 *
 * The unread count stays on its own door (the WS `focus` ping in
 * `useWebSocket`), armed by the focused chat with the same dwell and re-armed,
 * like this one, when the window comes back.
 */
import { useEffect } from 'react';
import { SEEN_DWELL_MS, signalsActions, useSignalsStore } from './signals';
import { holdSubjectInFront, seeChatFinished } from './chatInView';
import { isWindowAwake, onWindowAwakeChange } from './windowAwake';
import { useProjectFocusStore } from './projectFocus';
import { createPaneId, getTerminalSessionFromPaneId } from './pane/adapters/paneConfig';
import { isUtilityPanelId } from './pane/adapters/utilityPanelId';
import { useUnseenNotificationsStore } from './notificationUnseen';
import { markTargetSeen } from '../lib/notify/history';
import { TERMINAL_TARGET_KIND, terminalNotificationGroupKey } from '../../../shared/notification-log';

/**
 * The subject a pane id stands for: a terminal's session id, a chat's topic id
 * (`chat:<id>` inside a project, the bare topic id at the top level), or null
 * for a pane that carries no mark (browser, file, utility, draft, project).
 */
export function subjectOfPaneId(paneId: string | null | undefined): string | null {
  if (!paneId) return null;
  const sid = getTerminalSessionFromPaneId(paneId);
  if (sid !== null) return sid || null;
  if (paneId.startsWith('chat:')) return paneId.slice('chat:'.length) || null;
  if (paneId.includes(':') || isUtilityPanelId(paneId)) return null;
  return paneId;
}

/**
 * The subject of the pane the window has in front. A project window is one
 * pane at the top level; the pane in front inside it is the focused inner one
 * it publishes in `activePaneByProject` (the same two levels the banner rules
 * read, `isTerminalPaneSelected`). Exact comparisons only.
 */
export function focusedSubjectOf(
  focusedPanelId: string | null | undefined,
  activePaneByProject: Record<string, string | null>,
): string | null {
  if (!focusedPanelId) return null;
  if (!focusedPanelId.startsWith('project:')) return subjectOfPaneId(focusedPanelId);
  for (const [projectPath, inner] of Object.entries(activePaneByProject)) {
    if (createPaneId('project', projectPath) === focusedPanelId) return subjectOfPaneId(inner);
  }
  return null;
}

type MarkSets = {
  seenSubjects: ReadonlySet<string>;
  terminalFinishedIds: ReadonlySet<string>;
  chatFinishedTopics: ReadonlySet<string>;
};

/** Does the subject carry something the seen event would clear? A subject not
 *  yet seen (its "seen" flag dropped by a new "your turn") counts too, and so
 *  does an unseen history row grouped under it as a terminal
 *  (`unseenNotificationKeys`, the bell's keys). */
export function hasUnseenMark(s: MarkSets, id: string, unseenNotificationKeys?: ReadonlySet<string>): boolean {
  return (
    !s.seenSubjects.has(id) ||
    s.terminalFinishedIds.has(id) ||
    s.chatFinishedTopics.has(id) ||
    !!unseenNotificationKeys?.has(terminalNotificationGroupKey(id))
  );
}

/**
 * THE seen event: every mark of `id`, at once. The "seen" flag the fills and
 * rollups read, the terminal's finished mark (and its history rows on the
 * server, through the facade), a terminal's unseen history rows with no
 * finished mark (a hook-driven claude-code terminal), the chat's 'done' mark
 * (and the other windows, through the seen door, `takeChatDoneSeen`).
 */
export function seeSubject(id: string): void {
  const st = useSignalsStore.getState();
  st.markSubjectSeen(id);
  if (st.terminalFinishedIds.has(id)) signalsActions.clearTerminalFinished(id);
  else if (useUnseenNotificationsStore.getState().keys.has(terminalNotificationGroupKey(id))) {
    markTargetSeen(TERMINAL_TARGET_KIND, id);
  }
  seeChatFinished(id);
}

/**
 * Arms the seen dwell on `subject` while it is in front: declared in front for
 * the mark decisions, and seen after SEEN_DWELL_MS of continuous look with the
 * window awake. The dwell re-arms whenever the subject gets a new mark, so a
 * turn that ends on the pane you are looking at clears after the dwell instead
 * of staying until you click somewhere else and back.
 */
function useSeenSubjectInFront(subject: string | null): void {
  // Declared in front for the mark decisions (`isSubjectInFront`): a turn that
  // ends on it while the window is awake raises no mark at all.
  useEffect(() => (subject ? holdSubjectInFront(subject) : undefined), [subject]);
  const unseenNotificationKeys = useUnseenNotificationsStore((s) => s.keys);
  const unseen = useSignalsStore((s) => !!subject && hasUnseenMark(s, subject, unseenNotificationKeys));
  useEffect(() => {
    if (!subject || !unseen) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const arm = () => {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        // The window can have gone behind during the wait without an event.
        if (!disposed && isWindowAwake()) seeSubject(subject);
      }, SEEN_DWELL_MS);
    };
    const disarm = () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    };
    // Only a continuous look counts: a window that goes behind restarts the wait.
    const onAwakeChange = () => { if (isWindowAwake()) arm(); else disarm(); };
    onAwakeChange();
    const stopListening = onWindowAwakeChange(onAwakeChange);
    return () => {
      disposed = true;
      disarm();
      stopListening();
    };
  }, [subject, unseen]);
}

/**
 * The seen dwell on a pane in front: the window's focused pane (App), or the
 * pane a group draws as focused while no pane is (StandaloneChatGroup). A
 * project window stands for its focused inner pane.
 */
export function useSeenFocusedPane(paneId: string | null): void {
  const activePaneByProject = useProjectFocusStore((s) => s.activePaneByProject);
  useSeenSubjectInFront(focusedSubjectOf(paneId, activePaneByProject));
}

/** The seen dwell as an element, for a subject drawn in front inside a pane
 *  that has none of its own (the board's coordinator drawer). */
export function SubjectInFront({ subjectId }: { subjectId: string | null }): null {
  useSeenSubjectInFront(subjectId);
  return null;
}
