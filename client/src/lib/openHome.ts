/**
 * OPEN A SETTING WHERE IT IS USED, from anywhere.
 *
 * There is no settings section any more (USERMENU-06, SETHOME-01): each form
 * lives beside the thing it configures. The AI providers open from the model
 * selector, the MCP tools from the composer's «+», the calendar from the pinned
 * calendar tile; the plan, the machines, the look and the notifications are the
 * user menu's own levels, because they ARE the account and its machines.
 *
 * A home is not always on screen (no chat open means no model selector), so the
 * three forms that live outside the menu are drawn by ONE host
 * (`Settings/HomePanelHost`): anchored to the element that asked, or to the
 * home's own element when one is mounted (`data-home-anchor`), or, with neither,
 * as a centred sheet. Every door (the palette's commands, the plan-limit
 * notice, the selector's footer) sends the same event and lets the host decide.
 */

/** The event the host listens to. */
export const OPEN_HOME_EVENT = 'topics:open-home';

/** The forms the host draws itself. */
export type PanelHome = 'providers' | 'tools' | 'calendar';

/** Every home a door can ask for: the three panels, and the user menu's own. */
export type SettingHome = PanelHome | 'plan' | 'machines' | 'appearance' | 'notifications';

export interface OpenHomeDetail {
  home: SettingHome;
  /** The element the panel hangs from. Absent: the home's own, if mounted. */
  anchor?: HTMLElement | null;
}

/** Open `home`, hung from `anchor` when given. */
export function openHome(home: SettingHome, anchor?: HTMLElement | null): void {
  window.dispatchEvent(new CustomEvent<OpenHomeDetail>(OPEN_HOME_EVENT, { detail: { home, anchor: anchor ?? null } }));
}

/** The attribute a home puts on its element so a door without an anchor (the
 *  palette) can still open the panel beside it. A space-separated list. */
export const HOME_ANCHOR_ATTR = 'data-home-anchor';

export function isPanelHome(home: SettingHome): home is PanelHome {
  return home === 'providers' || home === 'tools' || home === 'calendar';
}
