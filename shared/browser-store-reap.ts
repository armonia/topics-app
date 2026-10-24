/**
 * THE CLEANUP OF CLOSED BROWSERS' DATA, as both sides see it.
 *
 * Closing a browser pane drops its cache and keeps its identity (cookies,
 * local storage), so a store whose context never comes back stays on disk
 * forever. `client/src/lib/browserDataStoreReaper.ts` removes those stores,
 * and the removal cannot be undone: every login and every site's local data in
 * them go for good. So it is a setting of Topics (Attilio, approving #425), in
 * two columns of `app_settings`:
 *
 *   browserStoreReapEnabled    NULL = never touched = ON
 *   browserStoreReapAfterDays  NULL = the default, 60 days without use
 *
 * The default is ON because the stores it removes belong to browsers nobody
 * opens any more (no row of `ui_state` names them) and that nobody has touched
 * for two months; the setting exists so that whoever wants them kept can say so.
 *
 * Both sides clamp the days to 7..365: the server when it saves, the reaper
 * again before it calls Tauri, so a row written by hand or by an older build
 * still reaches the disk inside the range. The Rust side keeps its own floor of
 * 7 days (`MIN_REAP_AGE_DAYS` in desktop-tauri/src-tauri/src/lib.rs).
 */

/** The shortest wait the setting accepts: a store idle for less than a week is
 *  not a store whose browser is gone. Same number as the Rust floor. */
export const BROWSER_STORE_REAP_MIN_DAYS = 7;

/** The longest: past a year the setting means "never", which is the switch. */
export const BROWSER_STORE_REAP_MAX_DAYS = 365;

/** Two months, the value the reaper used before it was a setting. */
export const BROWSER_STORE_REAP_DEFAULT_DAYS = 60;

/** A number of days brought back inside 7..365, in whole days. NaN is not a
 *  number of days at all and reads as the default. */
export function clampBrowserStoreReapDays(days: number): number {
  if (Number.isNaN(days)) return BROWSER_STORE_REAP_DEFAULT_DAYS;
  return Math.min(BROWSER_STORE_REAP_MAX_DAYS, Math.max(BROWSER_STORE_REAP_MIN_DAYS, Math.round(days)));
}

/** What the reaper does, once the stored values are read. */
export interface BrowserStoreReapChoice {
  enabled: boolean;
  afterDays: number;
}

/**
 * The stored values, resolved. Only an explicit `false` switches the cleanup
 * off: NULL, and a field a server older than the setting does not send, both
 * mean never touched, which is ON at 60 days. The fields are `unknown` because
 * the reaper hands over a JSON body as it arrived.
 */
export function resolveBrowserStoreReap(stored: {
  browserStoreReapEnabled?: unknown;
  browserStoreReapAfterDays?: unknown;
}): BrowserStoreReapChoice {
  const days = stored.browserStoreReapAfterDays;
  return {
    enabled: stored.browserStoreReapEnabled !== false,
    afterDays: typeof days === 'number' ? clampBrowserStoreReapDays(days) : BROWSER_STORE_REAP_DEFAULT_DAYS,
  };
}
