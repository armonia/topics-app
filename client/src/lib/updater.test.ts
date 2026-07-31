/**
 * shouldShowUpdaterToast — la tabella di verità del toast dell'updater.
 *
 * Il caso che ha motivato il flag `silent`: finché non esiste una release
 * FIRMATA l'endpoint dell'updater risponde 404, e il controllo automatico al
 * boot piazzava un toast di errore a ogni avvio dell'app — per qualcosa che
 * l'utente non ha chiesto e non può risolvere. Un aggiornamento davvero
 * disponibile deve invece uscire SEMPRE, anche se il controllo era silenzioso.
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
