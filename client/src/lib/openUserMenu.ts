/**
 * OPEN THE USER MENU, optionally on one of its levels, from anywhere.
 *
 * The preferences moved out of the Settings panel into the user menu, and the
 * doors that led to a section of the panel now lead to a level of the menu: the
 * bell's gear to Notifications, an old deep link to Devices. The menu is owned
 * by two hosts (the user card on the desktop, the title menu on the phone) that
 * no caller can reach through props, so the request is an event, in the same
 * shape as `topics:open-settings` and `topics:open-utility`.
 */

/** The event both hosts listen to. */
export const OPEN_USER_MENU_EVENT = 'topics:open-user-menu';

/** The levels a request can land on. */
export type UserMenuLevel = 'appearance' | 'notifications' | 'view' | 'devices';

export interface OpenUserMenuDetail {
  level?: UserMenuLevel;
}

/** Open the user menu, with `level` already open when given. */
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
}
