/**
 * OPEN THE SETTINGS PANEL ON A SECTION, from anywhere.
 *
 * The panel is state held by `App` (`showSettings` + `settingsSection`), so
 * only what App renders directly can open it through props: a PANE cannot, and
 * the Profile tab is a pane. Its pages need that door — "manage this group"
 * from the org chip, "devices" from a profile page — and without this event
 * they would each need a prop drilled down through the pane tree, which is the
 * same door built four times.
 *
 * The identity rows themselves did NOT move: they are still at the bottom of
 * the sidebar (`Sidebar/SidebarStatusBar`), where a prop reaches them fine, and
 * that is the path they still use.
 *
 * One event, like `topics:open-utility` for the panes: the sender says WHERE it
 * wants to land, App listens and opens. No new store, no prop drilled through
 * the pane tree.
 */
import type { SectionId } from '@/components/Settings/sections';

/** The event App listens to. Exported so the listener and the sender cannot
 *  drift on a string. */
export const OPEN_SETTINGS_EVENT = 'topics:open-settings';

/** The sections a deep link can land on: EVERY section of the panel, which is
 *  the same list the panel draws its own rail from (`SETTINGS_SECTIONS`).
 *
 *  It used to be five hand-picked ids, and the hand-picking was the defect:
 *  the user menu now offers the sections themselves as a level, so «take me to
 *  the providers» is one gesture instead of opening the panel and hunting for
 *  the row. A subset here would mean a menu entry that lands on the panel's
 *  default page and looks broken. One list, and it is the panel's own. */
export type SettingsPanelSection = SectionId;

export interface OpenSettingsDetail {
  section?: SettingsPanelSection;
}

/** Open Settings, optionally on a given section. */
export function openSettings(section?: SettingsPanelSection): void {
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { section } }),
  );
}
