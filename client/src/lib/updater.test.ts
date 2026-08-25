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
