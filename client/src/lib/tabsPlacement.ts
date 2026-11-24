/**
 * WHERE THE TABS ARE: in one place, never in two.
 *
 * On a desktop the open surfaces were listed twice, in the sidebar column and
 * in the strip across the top of the window (24/11: «non ha senso che ci sia
 * sia tab sopra che tab sul lato, si dovrebbe poter scegliere»). The phone had
 * already dropped the strip for the same reason (see the `mobile` prop of
 * `StandaloneChatGroup`). This is the one function that answers, so the strip
 * and the column cannot disagree about which of them holds the tabs.
 */
import type { AppSettings } from '../types';

export type TabsPosition = AppSettings['tabsPosition'];

export interface TabsPlacement {
  /** The strip of tabs across the top of the window is drawn. Without it the
   *  row on top says the name of the surface in front. */
  strip: boolean;
  /** The column leaves out the rows the strip already shows. */
  columnSkipsStrip: boolean;
}

export function tabsPlacement(
  position: TabsPosition,
  { phone, sidebarCollapsed }: { phone: boolean; sidebarCollapsed: boolean },
): TabsPlacement {
  // The phone keeps its own grammar whatever the desktop chose: the column is
  // the list of surfaces and the row on top says the name of the one in front.
  if (phone) return { strip: false, columnSkipsStrip: false };
  if (position === 'top') return { strip: true, columnSkipsStrip: true };
  // Tabs at the side, but the column is closed: they would be nowhere, so they
  // come back on top until the column opens again.
  return { strip: sidebarCollapsed, columnSkipsStrip: false };
}
