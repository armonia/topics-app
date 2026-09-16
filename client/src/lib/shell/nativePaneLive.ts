/**
 * When a native browser pane is allowed to be live.
 *
 * A pane that is not heavy keeps today's rule, which lives in `useTauriBrowser`
 * (shown while visible, or while an agent uses it). A HEAVY pane is live only
 * while it has the focus: its own pane is the focused one AND its window is not
 * known to be unfocused. The owner's answer of 15/09 reads "solo al focus" as the
 * focus of the pane itself: a heavy preview next to the chat you are typing in
 * pauses, and comes back live when you select it.
 *
 * Exemptions keep a heavy pane live without focus: an agent driving it (or an op
 * in flight), and an open inspector, which takes the key window from Topics and
 * would otherwise freeze the page being debugged.
 */

/** From "should pause" to the snapshot. A Cmd+Tab glance or a click on the tab
 *  bar and back returns inside it and pays nothing. */
export const PAUSE_DWELL_MS = 2_000;

export interface PaneLiveInput {
  heavy: boolean;
  /** The pane is the focused one of its surface (`hasFocus` of its mount site). */
  paneFocused: boolean;
  /** `null` = nobody answered, which counts as focused. */
  windowFocused: boolean | null;
  agentActive: boolean;
  opsInFlight: number;
  devtoolsOpen: boolean;
}

export function paneLive(i: PaneLiveInput): boolean {
  if (!i.heavy) return true;
  if (i.agentActive || i.opsInFlight > 0 || i.devtoolsOpen) return true;
  return i.windowFocused !== false && i.paneFocused;
}
