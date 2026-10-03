/**
 * ONE "SEEN" PER PANE: the window's focused pane, looked at for the dwell.
 *
 * There is one subject in front per window: the pane the window has focused
 * (`focusedPanelId`, or the focused inner pane of a focused project window),
 * whatever input put it there: a tab click, a click or tap inside the pane,
 * the keyboard, the palette, a sidebar row. When it has been in front, with
 * the window awake, for SEEN_DWELL_MS, ONE event (`seeSubject`) sends the seen
 * to the server's door (`POST /api/attention/seen`, ATTN-06) with the epoch
 * and the turn this window was showing. The server answers every window and
 * device with `attention:updated`, and every surface reads that one frame:
 * the tab, the sidebar row, the project and group rollups, the inbox and the
 * Dock. Nothing here keeps a mark of its own.
 *
 * The dwell is armed only while the subject has something to tell the server
 * (`needsSeen`): a lit epoch not seen, unread messages, or a closed turn not
 * seen (a chat in `background` read by the person, so the end of its wait does
 * not light it again, design section 6). A question already seen stays amber
 * and asks for nothing more.
 *
 * A pane can be in front with no focus to name it: with `focusedPanelId` null
 * (a new device, after a drop) the group draws its active tab as focused, so
 * the group holds that pane in front itself (`StandaloneChatGroup`). The
 * board's coordinator chat lives in a drawer inside the board pane, which has
 * no subject of its own: the drawer holds the coordinator (`SubjectInFront`).
 */
import { useEffect } from 'react';
import { SEEN_DWELL_MS } from './signals';
import { holdSubjectInFront } from './chatInView';
import { isWindowAwake, onWindowAwakeChange } from './windowAwake';
import { useProjectFocusStore } from './projectFocus';
import { createPaneId, getTerminalSessionFromPaneId } from './pane/adapters/paneConfig';
import { isUtilityPanelId } from './pane/adapters/utilityPanelId';
import { attentionOfRow, needsSeen, sendAttentionSeen, useAttentionStore } from './attention';
import { terminalSubject, topicSubject } from '../../../shared/attention';

/**
 * The attention subject a pane id stands for: `terminal:<session>` for a
 * terminal, `topic:<id>` for a chat (`chat:<id>` inside a project, the bare
 * topic id at the top level), or null for a pane that carries no attention
 * (browser, file, utility, draft, project).
 */
export function subjectOfPaneId(paneId: string | null | undefined): string | null {
  if (!paneId) return null;
  const sid = getTerminalSessionFromPaneId(paneId);
  if (sid !== null) return sid ? terminalSubject(sid) : null;
  if (paneId.startsWith('chat:')) return paneId.length > 'chat:'.length ? topicSubject(paneId.slice('chat:'.length)) : null;
  if (paneId.includes(':') || isUtilityPanelId(paneId)) return null;
  return topicSubject(paneId);
}

/**
 * The subject of the pane the window has in front. A project window is one
 * pane at the top level; the pane in front inside it is the focused inner one
 * it publishes in `activePaneByProject`. Exact comparisons only.
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

/** THE seen event: the subject's epoch and turn, to the server's door, applied here first. */
export function seeSubject(subject: string): void {
  sendAttentionSeen([subject]);
}

/**
 * Arms the seen dwell on `subject` while it is in front: declared in front for
 * the server (`holdSubjectInFront`, the `focus` frame), and seen after
 * SEEN_DWELL_MS of continuous look with the window awake. The dwell re-arms
 * whenever the subject has something new to see, so a turn that ends on the
 * pane you are looking at clears after the dwell instead of staying until you
 * click somewhere else and back.
 */
function useSeenSubjectInFront(subject: string | null): void {
  useEffect(() => (subject ? holdSubjectInFront(subject) : undefined), [subject]);
  const pending = useAttentionStore((s) => !!subject && needsSeen(attentionOfRow(s.rows.get(subject), subject)));
  useEffect(() => {
    if (!subject || !pending) return;
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
  }, [subject, pending]);
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
export function SubjectInFront({ subject }: { subject: string | null }): null {
  useSeenSubjectInFront(subject);
  return null;
}
