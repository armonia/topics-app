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

describe("in automatico non si annuncia un aggiornamento che arriva da solo", () => {
  // Segnalato DUE volte: «mi esce nuova versione disponibile anche se sono in
  // modalità automatica», e poi «ancora mi esce nuova versione disponibile».
  // La prima correzione aveva sistemato il PANNELLO della versione e non questo
  // banner, che è una seconda superficie con la stessa frase — il difetto era
  // sopravvissuto in un posto che nessuno aveva guardato.
  const auto = { dismissed: false, versionPopoverOpen: false, autoUpdate: true };

  test("«disponibile» non compare: le finestre si ricaricano da sole", () => {
    const s: UpdaterStatus = { state: "update-available", version: "2.3.0" };
    expect(shouldShowUpdaterToast(s, quiet)).toBe(true);
    expect(shouldShowUpdaterToast(s, auto)).toBe(false);
  });

  test("nemmeno lo scaricamento in corso: è un lavoro che non hai chiesto", () => {
    expect(shouldShowUpdaterToast({ state: "downloading", percent: 40 }, auto)).toBe(false);
  });

  test("«pronto» invece PASSA: lì il gesto serve davvero", () => {
    // C'è un binario scaricato che aspetta un riavvio. È l'unico stato in cui
    // la persona deve fare qualcosa, e tacere lascerebbe l'aggiornamento in
    // panchina per sempre.
    expect(shouldShowUpdaterToast({ state: "ready", version: "2.3.0" }, auto)).toBe(true);
  });

  test("senza il flag non cambia niente: chi non è in automatico vede tutto", () => {
    // La regola vale solo dove l'aggiornamento arriva davvero da sé. Applicarla
    // sempre renderebbe l'app muta su una macchina che aspetta un clic.
    const s: UpdaterStatus = { state: "update-available", version: "2.3.0" };
    expect(shouldShowUpdaterToast(s, { ...quiet, autoUpdate: false })).toBe(true);
  });
});
