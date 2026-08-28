/**
 * shouldShowUpdaterToast — la tabella di verità del toast dell'updater.
 *
 * Il caso che ha motivato il flag `silent`: finché non esiste una release
 * FIRMATA l'endpoint dell'updater risponde 404, e il controllo automatico al
 * boot piazzava un toast di errore a ogni avvio dell'app — per qualcosa che
 * l'utente non ha chiesto e non può risolvere. Un aggiornamento davvero
 * disponibile deve invece uscire SEMPRE, anche se il controllo era silenzioso.
  * @covers UPDATER-01
 */
import { describe, test, expect } from 'bun:test';
import { shouldShowUpdaterToast, type UpdaterStatus } from './updater';

const quiet = { dismissed: false, versionPopoverOpen: false };

describe('shouldShowUpdaterToast', () => {
  test('idle non disegna niente', () => {
    expect(shouldShowUpdaterToast({ state: 'idle' }, quiet)).toBe(false);
  });

  test('gli stati che chiedono qualcosa si vedono', () => {
    const states: UpdaterStatus['state'][] = ['checking', 'update-available', 'downloading', 'ready', 'error'];
    for (const state of states) {
      expect(shouldShowUpdaterToast({ state }, quiet)).toBe(true);
    }
  });

  test("l'esito di un controllo silenzioso resta muto — anche se è un errore", () => {
    expect(shouldShowUpdaterToast({ state: 'error', error: '404', silent: true }, quiet)).toBe(false);
    expect(shouldShowUpdaterToast({ state: 'idle', silent: true }, quiet)).toBe(false);
  });

  test('un aggiornamento disponibile esce anche se il controllo era al boot', () => {
    // È il produttore a marcare `silent: false` su update-available: qui si pinna
    // che il consumatore lo rispetta, cioè che "silenzioso" non è una proprietà
    // del CONTROLLO ma dell'ESITO.
    expect(
      shouldShowUpdaterToast({ state: 'update-available', version: '2.3.0', silent: false }, quiet),
    ).toBe(true);
  });

  test('chiuso dall’utente, o popover della versione aperto → niente doppioni', () => {
    const ready: UpdaterStatus = { state: 'ready' };
    expect(shouldShowUpdaterToast(ready, { dismissed: true, versionPopoverOpen: false })).toBe(false);
    expect(shouldShowUpdaterToast(ready, { dismissed: false, versionPopoverOpen: true })).toBe(false);
  });
});

describe("an available update is announced, because it no longer arrives by itself", () => {
  // THE OPPOSITE RULE USED TO LIVE HERE. With `autoUpdate` on, the banner stayed
  // quiet about everything except "ready", and the reason was sound for as long
  // as it was true: the windows reloaded themselves, so offering a "Scarica"
  // button asked for a gesture on work already under way. Reported twice, fixed
  // twice (fda59c2b the version panel, then this banner).
  //
  // It stopped being true. The shell now reinstalls and relaunches on its own
  // ONLY while the main window is hidden (may_relaunch_unattended), and while it
  // is hidden this toast is not drawn. So the branch could only fire in the case
  // it was never written for: an update waiting for a click, in an app with no
  // way left to mention it. On 2026-08-21 the app had already reinstalled and
  // relaunched itself eight times in one week.
  test("available shows: without the banner nobody would know", () => {
    const s: UpdaterStatus = { state: "update-available", version: "2.3.0" };
    expect(shouldShowUpdaterToast(s, quiet)).toBe(true);
  });

  test("ready shows: a downloaded binary is waiting for a restart", () => {
    expect(shouldShowUpdaterToast({ state: "ready", version: "2.3.0" }, quiet)).toBe(true);
  });

  test("downloading shows: it is the state between the other two", () => {
    expect(shouldShowUpdaterToast({ state: "downloading", progress: 40 }, quiet)).toBe(true);
  });

  test("the silent boot check stays silent", () => {
    // The one thing boot must not draw: the outcome of a check nobody asked for.
    const s: UpdaterStatus = { state: "update-available", version: "2.3.0", silent: true };
    expect(shouldShowUpdaterToast(s, quiet)).toBe(false);
  });
});

describe('closing the banner means "not this version"', () => {
  // 2026-08-27, reported twice in one evening:
  //   "mi dice ANCORA nuova versione v2.2.200 disponibile"  allow-italian: the
  //   reported words are what this test pins.
  // Nothing was wrong with the message - the machine was 23 versions behind -
  // but the "x" bought about four seconds. The boot check
  // runs on every launch, an available update publishes non-silent on purpose,
  // and the component reset `dismissed` on every status event, so the banner
  // came back for the same version forever.
  const seen = { dismissed: false, versionPopoverOpen: false, dismissedVersion: '2.2.200' };

  test('the dismissed version stays quiet across a new check', () => {
    expect(
      shouldShowUpdaterToast({ state: 'update-available', version: '2.2.200' }, seen),
    ).toBe(false);
  });

  test('a newer version speaks again — the rule must not become a mute button', () => {
    expect(
      shouldShowUpdaterToast({ state: 'update-available', version: '2.2.203' }, seen),
    ).toBe(true);
  });

  test('only update-available is versioned: ready and error are not silenced', () => {
    // `ready` is a downloaded binary waiting for a restart, `error` is something
    // that just went wrong. Neither is "the announcement of version X", so the
    // memory of a closed announcement must not reach them.
    expect(shouldShowUpdaterToast({ state: 'ready', version: '2.2.200' }, seen)).toBe(true);
    expect(shouldShowUpdaterToast({ state: 'error', error: 'boom' }, seen)).toBe(true);
  });

  test('nothing dismissed yet — the banner shows', () => {
    const fresh = { dismissed: false, versionPopoverOpen: false, dismissedVersion: null };
    expect(
      shouldShowUpdaterToast({ state: 'update-available', version: '2.2.200' }, fresh),
    ).toBe(true);
  });

  test('an update with no version cannot be remembered, so it always shows', () => {
    expect(shouldShowUpdaterToast({ state: 'update-available' }, seen)).toBe(true);
  });
});
