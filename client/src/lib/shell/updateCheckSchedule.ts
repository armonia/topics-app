/**
 * WHEN the app looks for a new version, which turned out to be "once, ever".
 *
 * The boot check alone is enough only for an app that gets restarted. Topics is
 * not that app: it is a login item that stays open for days. Measured on the
 * Windows machine on 2026-08-29, over SSH: the last update it fetched was
 * 2.2.211 at 21:23 on 28/08, and by then four more releases had been published
 * (2.2.212 through 2.2.215), none of them downloaded. The release pipeline was
 * fine - `latest.json` carries a signed `windows-x86_64` entry - and the
 * machine was perfectly able to update. Nobody ever asked it to.
 *
 * That is why a Windows fix could ship and the person on Windows would still be
 * looking at the defect: the fix was two versions ahead of what their app would
 * ever offer them.
 *
 * The repeat is SILENT, like the boot check: it only draws something when there
 * really is a new version. A periodic check that announced "you are up to date"
 * would be a notification nobody asked for, four times a day.
 *
 * Lives in its own module because it is the behaviour that failed, and a
 * `setInterval` buried in a component effect cannot be measured: component
 * tests here render with `renderToStaticMarkup`, so effects never run.
 */

/** Let first paint and the sidecar settle before the first check. */
export const UPDATE_BOOT_DELAY_MS = 4_000;

/**
 * How often to look again.
 *
 * Six hours: often enough that a machine left open overnight wakes up knowing
 * about the morning's release, rare enough that it is four requests a day
 * against the release endpoint. The number is not sacred; the repeat is.
 */
export const UPDATE_RECHECK_MS = 6 * 60 * 60_000;

/**
 * Runs `check` once after the boot delay, then every period. Returns the stop.
 *
 * Timers are the real ones on purpose: the test drives it with a boot delay and
 * a period of a few milliseconds, which measures the same code the app runs
 * instead of a fake clock wired to an injected pair of functions.
 */
export function startUpdateChecks(
  check: () => void,
  opts: { bootDelayMs?: number; periodMs?: number; devInstall?: boolean } = {},
): () => void {
  // A DEV INSTALL IS NOT OFFERED A PACKAGED BUILD.
  //
  // On the machine that builds the app the client bundle is hot-delivered from
  // `public/` (that is what `topics-dev.json` and `server.devReload` mean), so
  // the number on screen tracks the repo while the shell stays at whatever was
  // last installed. The automatic check then announces a "new version" that the
  // person there has already got in source, over and over. Reported twice. The
  // second report, in the user's own words:
  // "ancora in locale mi porta le finestrelle NUOVA VERSIONE anche se sono in dev" // allow-italian: quoted report
  //
  // Only the AUTOMATIC checks stop. The menu item and the version popover still
  // check and still say what they find: asking is a deliberate gesture, and the
  // shell really can be behind. What goes away is the nagging.
  if (opts.devInstall) return () => {};
  const boot = setTimeout(check, opts.bootDelayMs ?? UPDATE_BOOT_DELAY_MS);
  const repeat = setInterval(check, opts.periodMs ?? UPDATE_RECHECK_MS);
  return () => {
    clearTimeout(boot);
    clearInterval(repeat);
  };
}
