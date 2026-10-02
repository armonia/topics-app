/**
 * OPEN THE USER MENU, optionally on one of its levels, from anywhere.
 *
 * The user menu is the one home of every setting: the preferences, and since
 * the Settings panel went away the forms too (AI providers, tools, calendar,
 * plan, nodes). Every door that led to a page of the panel now leads to a level
 * of the menu: the bell's gear to Notifications, the plan-limit notice and the
 * model selector to AI providers, ⌘, to the menu itself. The menu is owned by
 * two hosts (the user card on the desktop, the title menu on the phone) that no
 * caller can reach through props, so the request is an event, in the same shape
 * as `topics:open-utility`.
 */

/** The event both hosts listen to. */
export const OPEN_USER_MENU_EVENT = 'topics:open-user-menu';

/** The levels a request can land on. */
export type UserMenuLevel =
  | 'plan'
  | 'devices'
  | 'nodes'
  | 'providers'
  | 'tools'
  | 'calendar'
  | 'appearance'
  | 'notifications'
  | 'view';

export interface OpenUserMenuDetail {
  level?: UserMenuLevel;
}

/** Open the user menu, with `level` already open when given. Without a level
 *  (⌘, and the palette) the focus lands on the menu's first row. */
export function openUserMenu(level?: UserMenuLevel): void {
  window.dispatchEvent(new CustomEvent<OpenUserMenuDetail>(OPEN_USER_MENU_EVENT, { detail: { level } }));
}

/**
 * A level request as a value that changes on every request, so a host can
 * remount its menu (and with it the `defaultOpen` level) even when the same
 * level is asked for twice in a row.
 */
export interface UserMenuRequest {
  level: UserMenuLevel | null;
  n: number;
  /** Asked from the keyboard without a level (⌘,): focus the first row. */
  focusFirst?: boolean;
}
