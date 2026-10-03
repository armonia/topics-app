/**
 * OPEN THE USER MENU, optionally on one of its levels, from anywhere.
 *
 * The user menu holds who you are and how the app looks: the account and its
 * plan, the people, the devices with the machines, Appearance, Notifications,
 * View. The other forms live where they are used (`lib/openHome`). Doors that
 * land here: the bell's gear on Notifications, ⌘, on the menu itself, and the
 * palette's commands for the plan, the machines, the look and the
 * notifications. The menu is owned by two hosts (the user card on the desktop,
 * the title menu on the phone) that no caller can reach through props, so the
 * request is an event, in the same shape as `topics:open-utility`.
 */

/** The event both hosts listen to. */
export const OPEN_USER_MENU_EVENT = 'topics:open-user-menu';

/** The levels a request can land on. */
export type UserMenuLevel =
  | 'plan'
  | 'devices'
  /** Devices, with its Machines section open. */
  | 'nodes'
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
  /**
   * Bumped by a request that arrives while the menu is ALREADY open. `n` then
   * stays put: remounting would throw away a half-typed form in an open level.
   * The host moves the focus instead (the first row, or the level asked for).
   */
  focusN?: number;
}
