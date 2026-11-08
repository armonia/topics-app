/**
 * THE CLEANUP OF CLOSED BROWSERS' DATA, as both sides see it.
 *
 * Closing a browser pane drops its cache and keeps its identity (cookies,
 * local storage), so a store whose context never comes back stays on disk
 * forever. `client/src/lib/browserDataStoreReaper.ts` cleans those stores up,
 * at two levels, because the two things it can take are not the same thing
 * (Attilio, on #425: cookies and history are what keep the logins, so removing
 * the whole store cannot be the default; "at most one that only clears the
 * cache, to keep what is useful"). Three columns of `app_settings`:
 *
 *   browserStoreCacheReapEnabled  LEVEL 1, "empty the cache of closed browsers".
 *                                 NULL = never touched = ON. It removes ONLY the
 *                                 cache of an orphan idle store and keeps the
 *                                 logins, the cookies, the local storage.
 *   browserStoreReapEnabled       LEVEL 2, "also delete logins and history".
 *                                 NULL = never touched = OFF. Only an explicit
 *                                 true turns it on, and it counts only while
 *                                 level 1 is on: it is today's whole-store
 *                                 removal, which cannot be undone.
 *   browserStoreReapAfterDays     shared by both levels. NULL = the default,
 *                                 60 days without use.
 *
 * The default is the harmless level: a store that nobody opens for two months
 * only gives back its cache, and the person who wants the logins gone too has
 * to say so, in a switch they can see.
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

/** What the reaper may remove: nothing, the cache of the idle orphan stores, or
 *  the whole stores (cache, logins, cookies, local storage). */
export type BrowserStoreReapMode = 'off' | 'cache' | 'all';

/** What the reaper does, once the stored values are read. */
export interface BrowserStoreReapChoice {
  mode: BrowserStoreReapMode;
  /** Level 1 as stored: only an explicit false switches it off. */
  cacheEnabled: boolean;
  /** Level 2 as stored: only an explicit true switches it on. It is kept even
   *  while level 1 is off, so the panel still shows what was chosen; the mode
   *  is what says whether it counts. */
  wholeEnabled: boolean;
  afterDays: number;
}

/**
 * The stored values, resolved. Level 1 is off only on an explicit `false`: NULL,
 * and a field a server older than the setting does not send, both mean never
 * touched, which is ON. Level 2 is the opposite: only an explicit `true` is on,
 * anything else (NULL, a missing field, a string, a number) is OFF, because it
 * is the level that cannot be undone. The fields are `unknown` because the
 * reaper hands over a JSON body as it arrived.
 *
 * `all` needs both: a level 2 left on over a level 1 turned off removes nothing.
 */
export function resolveBrowserStoreReap(stored: {
  browserStoreCacheReapEnabled?: unknown;
  browserStoreReapEnabled?: unknown;
  browserStoreReapAfterDays?: unknown;
}): BrowserStoreReapChoice {
  const days = stored.browserStoreReapAfterDays;
  const cacheEnabled = stored.browserStoreCacheReapEnabled !== false;
  const wholeEnabled = stored.browserStoreReapEnabled === true;
  return {
    mode: !cacheEnabled ? 'off' : wholeEnabled ? 'all' : 'cache',
    cacheEnabled,
    wholeEnabled,
    afterDays: typeof days === 'number' ? clampBrowserStoreReapDays(days) : BROWSER_STORE_REAP_DEFAULT_DAYS,
  };
}
