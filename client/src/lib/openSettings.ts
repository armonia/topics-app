/**
 * OPEN THE SETTINGS PANEL ON A SECTION, from anywhere.
 *
 * The panel is state held by `App` (`showSettings` + `settingsSection`), so
 * only what App renders directly can open it through props: a PANE cannot. One
 * event, like `topics:open-utility` for the panes: the sender says WHERE it
 * wants to land, App listens and opens.
 *
 * THE PANEL HOLDS THE FORMS ONLY (USERMENU-06): providers, tools, calendar,
 * plan, nodes. What used to be a section and moved away keeps working as a
 * destination: an old id arriving on the event (a stale window, a deep link
 * written before the move) is sent to its new home by `routeSettingsRequest`,
 * not dropped on the panel's first page. In code the type no longer accepts
 * those ids, so a caller cannot write one again.
 */
import type { SectionId } from '@/components/Settings/sections';
import type { UserMenuLevel } from './openUserMenu';
import type { PageProfile } from '@/state/profileTarget';

/** The event App listens to. Exported so the listener and the sender cannot
 *  drift on a string. */
export const OPEN_SETTINGS_EVENT = 'topics:open-settings';

/** The sections a deep link can land on: every section of the panel. */
export type SettingsPanelSection = SectionId;

export interface OpenSettingsDetail {
  /** A string and not `SectionId`: what arrives on the event may be an id
   *  from before the move (see `routeSettingsRequest`). */
  section?: string;
}

/** Open Settings, optionally on a given section. */
export function openSettings(section?: SettingsPanelSection): void {
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { section } }),
  );
}

/** Where a request for the panel actually lands. */
export type SettingsRoute =
  | { to: 'panel'; section: SettingsPanelSection | undefined }
  | { to: 'user-menu'; level: UserMenuLevel }
  | { to: 'profile'; page: PageProfile };

const PANEL: ReadonlySet<string> = new Set<SettingsPanelSection>(['providers', 'tools', 'calendar', 'plan', 'nodes']);

/** The sections that left the panel, and where each one lives now. */
const MOVED: Record<string, SettingsRoute> = {
  appearance: { to: 'user-menu', level: 'appearance' },
  notifications: { to: 'user-menu', level: 'notifications' },
  devices: { to: 'user-menu', level: 'devices' },
  profile: { to: 'profile', page: 'profile' },
  followers: { to: 'profile', page: 'followers' },
  organization: { to: 'profile', page: 'organization' },
};

/** Pure: the destination of a section id, old or current. Unknown ids open
 *  the panel on its first page, as any request without a section does. */
export function routeSettingsRequest(section: string | undefined): SettingsRoute {
  if (section && PANEL.has(section)) return { to: 'panel', section: section as SettingsPanelSection };
  if (section && section in MOVED) return MOVED[section];
  return { to: 'panel', section: undefined };
}
