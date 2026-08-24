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
/** The event App listens to. Exported so the listener and the sender cannot
 *  drift on a string. */
export const EVENTO_IMPOSTAZIONI = 'topics:open-settings';

/** The sections a deep link can land on: the same set App's panel accepts as
 *  `initialSection`. Anything else is the panel's normal entry point.
 *
 *  `organization` is here because the profile tab stopped carrying it. The
 *  group is administration, not identity, and the door to it now leads where
 *  administration lives instead of into a profile page that no longer has it. */
export type SezioneImpostazioni = 'profile' | 'devices' | 'notifications' | 'organization';

export interface DettaglioImpostazioni {
  section?: SezioneImpostazioni;
}

/** Open Settings, optionally on a given section. */
export function apriImpostazioni(section?: SezioneImpostazioni): void {
  window.dispatchEvent(
    new CustomEvent<DettaglioImpostazioni>(EVENTO_IMPOSTAZIONI, { detail: { section } }),
  );
}
