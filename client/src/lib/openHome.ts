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
 * notice) sends the same event and lets the host decide.
 *
 * Providers and keys is a level of the model selector (revision 2026-10-04,
 * §5.1): the host hands such a request to the model chip of the focused pane
 * (`OPEN_MODEL_SELECTOR_EVENT`, on the chip itself), which opens its selector
 * on that level; only with no chip on screen does it draw a centred sheet.
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
  /**
   * Where the focus goes back when the panel closes, when that is not the
   * anchor. A command typed in the composer (`/mcp`, `/usage`) hands its own
   * field: the person was writing, and with the focus given to the «+» or to
   * the model chip the next words typed went nowhere.
   */
  returnFocus?: HTMLElement | null;
  /** Providers and keys only: open on this account's detail. */
  account?: string;
}

/** Open `home`, hung from `anchor` when given; on close the focus goes back to
 *  `returnFocus` when given, to the anchor otherwise. */
export function openHome(home: SettingHome, anchor?: HTMLElement | null, returnFocus?: HTMLElement | null, account?: string): void {
  window.dispatchEvent(new CustomEvent<OpenHomeDetail>(OPEN_HOME_EVENT, {
    detail: { home, anchor: anchor ?? null, returnFocus: returnFocus ?? null, account },
  }));
}

/**
 * The event a model chip listens to ON ITSELF: open your selector on the
 * providers level, or on one account's detail. Dispatched by the host, which
 * reads `defaultPrevented` to know a chip took it.
 */
export const OPEN_MODEL_SELECTOR_EVENT = 'topics:open-model-selector';

export interface OpenModelSelectorDetail {
  level: 'providers' | 'account';
  account?: string;
  returnFocus?: HTMLElement | null;
}

/**
 * The attribute a home puts on its element while the pane it belongs to is the
 * FOCUSED one. With two chats side by side there are two «+» and two model
 * chips on screen, and a door without an anchor (the palette) opened the panel
 * beside the first one in the document, i.e. in the pane on the left, whatever
 * pane the person was in.
 */
export const HOME_ANCHOR_FOCUSED_ATTR = 'data-home-anchor-focused';

/** The attribute a home puts on its element so a door without an anchor (the
 *  palette) can still open the panel beside it. A space-separated list. */
export const HOME_ANCHOR_ATTR = 'data-home-anchor';

export function isPanelHome(home: SettingHome): home is PanelHome {
  return home === 'providers' || home === 'tools' || home === 'calendar';
}
