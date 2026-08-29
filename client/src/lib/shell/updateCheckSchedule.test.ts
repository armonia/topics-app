/**
 * THE APP HAS TO LOOK AGAIN, not check once and never more.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * `UpdaterToast` asked for updates four seconds after launch and that was all:
 * no `setInterval`, and the only other paths were a user gesture (the menu
 * item, opening the version popover). Topics, though, is a login item that
 * stays open for days, so that single check is everything that happens.
 *
 * Measured on the Windows machine over SSH on 2026-08-29: the last update it
 * fetched was 2.2.211 at 21:23 on 28/08, and by then 2.2.212, 2.2.213, 2.2.214
 * and 2.2.215 had all been published - none downloaded. The release pipeline
 * was fine (`latest.json` carries a signed `windows-x86_64` entry) and the
 * machine knew how to update: nobody ever asked it to again.
 * The report, in the user's own words:
 * "windows ancora lo vedo con i problemi segnalati" // allow-italian: quoted report
 * - and the fix for those problems was two versions further along than their
 * app would ever offer them.
 *
 * This drives the real scheduler with tiny delays and counts the calls.
 * @covers UPDATER-03
 */
import { describe, expect, test } from 'bun:test';
import { startUpdateChecks, UPDATE_BOOT_DELAY_MS, UPDATE_RECHECK_MS } from './updateCheckSchedule';

/** A real wait: the timers are the real ones, the test drives them in ms. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('when the app looks for a new version', () => {
  test('after the boot check, MORE checks arrive', async () => {
    let calls = 0;
    const stop = startUpdateChecks(() => { calls++; }, { bootDelayMs: 5, periodMs: 20 });
    try {
      await wait(10);
      // The boot check: this one existed before the cure too.
      expect(calls).toBe(1);
      await wait(50);
      // And here the old version falls, the one that stopped at one forever.
      expect(calls).toBeGreaterThan(1);
    } finally { stop(); }
  });

  test('stopping really stops the repeat, not just the first shot', async () => {
    let calls = 0;
    const stop = startUpdateChecks(() => { calls++; }, { bootDelayMs: 5, periodMs: 10 });
    await wait(25);
    const atStop = calls;
    stop();
    await wait(40);
    // Without `clearInterval` on unmount, a page that remounts this effect
    // would pile up one more repeat every time.
    expect(calls).toBe(atStop);
  });

  test('the house delays are real numbers, not zero', () => {
    // A period of zero, or missing, would bring the defect back without
    // breaking anything: the repeat would exist in the code and never fire.
    expect(UPDATE_BOOT_DELAY_MS).toBeGreaterThan(0);
    expect(UPDATE_RECHECK_MS).toBeGreaterThan(UPDATE_BOOT_DELAY_MS);
    // Six hours: a machine left open overnight wakes up knowing about the
    // morning's release, and it is four requests a day, not forty.
    expect(UPDATE_RECHECK_MS).toBe(6 * 60 * 60_000);
  });
  test('a dev install is not nagged: zero automatic checks', async () => {
    let calls = 0;
    const stop = startUpdateChecks(() => { calls++; }, { bootDelayMs: 5, periodMs: 10, devInstall: true });
    await wait(40);
    stop();
    // Not "fewer": ZERO. On the machine that builds the app the bundle is
    // hot-delivered, so the version on screen tracks the repo while the shell
    // stays where it was installed, and every check announces a version the
    // person there already has in source. Reported twice.
    expect(calls).toBe(0);
  });

  test('outside a dev install nothing changes', async () => {
    let calls = 0;
    const stop = startUpdateChecks(() => { calls++; }, { bootDelayMs: 5, periodMs: 20, devInstall: false });
    try {
      await wait(10);
      // The exemption must not have swallowed the boot check for everyone else:
      // that would trade one silence for a worse one.
      expect(calls).toBe(1);
    } finally { stop(); }
  });
});
