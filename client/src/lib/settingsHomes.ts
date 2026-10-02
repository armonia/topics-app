/**
 * WHERE EACH PREFERENCE LIVES, as data a test can read.
 *
 * A home is a surface that shows the current value AND changes it, both ways.
 * Commands that only push a value in from somewhere else (the pause card's
 * «keep always», a project's «mute» in its context menu) are not homes: they
 * act on one item where it stands, and the list they feed is read and undone
 * in its home.
 */
import type { AppSettings } from '../types';

export type SettingSurface =
  | 'user-menu/appearance'
  | 'user-menu/notifications'
  | 'user-menu/view'
  | 'user-menu/system/performance'
  | 'sidebar-column';

export const SETTINGS_HOMES: Record<keyof AppSettings, readonly SettingSurface[]> = {
  fontSize: ['user-menu/appearance'],
  messageDensity: ['user-menu/appearance'],
  chatMaxWidth: ['user-menu/appearance'],
  floatingSplits: ['user-menu/appearance'],
  language: ['user-menu/appearance'],
  notificationsEnabled: ['user-menu/notifications'],
  notificationsSound: ['user-menu/notifications'],
  notifyEvenWhenFocused: ['user-menu/notifications'],
  mutedProjects: ['user-menu/notifications'],
  showBoardRow: ['user-menu/view'],
  keepLiveSites: ['user-menu/system/performance'],
  sidebarWidth: ['sidebar-column'],
  sidebarCollapsed: ['sidebar-column'],
  sidebarWidthExpanded: ['sidebar-column'],
};
