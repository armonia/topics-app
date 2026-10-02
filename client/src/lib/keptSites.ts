/**
 * THE SITES KEPT LIVE: heavy browser tabs never paused, by origin.
 *
 * The pause card's «keep always» adds a site; the Performance level of the
 * user menu lists them and takes one away (USERMENU-06: a preference that can
 * be added must be removable somewhere). Both read and write the one field of
 * `AppSettings`, through this module, so the pane and the list agree.
 */
import { loadSettings, saveSettings, SETTINGS_CHANGED_EVENT } from './settings';

/** Read from the settings once and again on every settings change (a choice
 *  made on another device arrives through the settings sync), not on every
 *  render of every browser pane. */
let cache: readonly string[] | null = null;

/** Stable for `useSyncExternalStore`. */
export function subscribeKeptSites(cb: () => void): () => void {
  const onChange = () => { cache = null; cb(); };
  window.addEventListener(SETTINGS_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
}

/** The kept origins; the same array until the settings change. */
export function keptSites(): readonly string[] {
  if (cache === null) cache = loadSettings().keepLiveSites ?? [];
  return cache;
}

export function keepSite(origin: string): void {
  const s = loadSettings();
  const cur = s.keepLiveSites ?? [];
  if (!cur.includes(origin)) saveSettings({ ...s, keepLiveSites: [...cur, origin] });
}

export function forgetKeptSite(origin: string): void {
  const s = loadSettings();
  const cur = s.keepLiveSites ?? [];
  if (cur.includes(origin)) saveSettings({ ...s, keepLiveSites: cur.filter((o) => o !== origin) });
}
