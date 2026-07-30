/**
 * Gate su Focus/Non disturbare (il "quiet gate").
 *
 * Perché esiste. `useCompletionNotifier` bussava a ogni turno finito senza
 * chiedersi se il Mac fosse in Focus: metti Focus per lavorare e Topics continua
 * a suonare. Il dato "sono in DND" non esiste sul web — lo sa solo il guscio
 * nativo (macOS, lato Rust) e viene spinto nella webview via
 * `window.__topicsFocusChanged`. Questo test fissa il contratto del gate:
 *
 *  1. DEFAULT SICURO: prima di qualunque lettura, e ovunque lo stato sia
 *     sconosciuto (web, macOS senza accesso), NON si silenzia — meglio un banner
 *     di troppo in Focus che perderlo per un'ipotesi.
 *  2. Si tace SOLO su una lettura POSITIVA e SUPPORTATA (`supported && active`).
 *  3. `supported=false` con `active=true` (host che non sa) NON silenzia: un push
 *     malformato o un "non lo so" non deve mai azzittire l'app.
 *
 * `bun test` non ha DOM: il modulo tocca solo `cache` in memoria, quindi basta
 * resettarlo tra i casi.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { isFocusSilencing, applyFocusStatus, __resetFocusForTests } from './focus';

beforeEach(() => {
  __resetFocusForTests();
});

describe('focus quiet-gate', () => {
  test('default is transparent — no reading yet ⇒ notify normally', () => {
    expect(isFocusSilencing()).toBe(false);
  });

  test('silences only on a positive, supported reading', () => {
    applyFocusStatus(true, true);
    expect(isFocusSilencing()).toBe(true);
  });

  test('supported but no focus ⇒ notify', () => {
    applyFocusStatus(false, true);
    expect(isFocusSilencing()).toBe(false);
  });

  test('unsupported host never silences, even if it claims active', () => {
    // e.g. a malformed push, or a host that cannot actually tell.
    applyFocusStatus(true, false);
    expect(isFocusSilencing()).toBe(false);
  });

  test('a focus turning off flips the gate back open', () => {
    applyFocusStatus(true, true);
    expect(isFocusSilencing()).toBe(true);
    applyFocusStatus(false, true);
    expect(isFocusSilencing()).toBe(false);
  });

  test('coerces non-boolean payloads (never poisons the gate)', () => {
    applyFocusStatus(1, 1);
    expect(isFocusSilencing()).toBe(true);
    applyFocusStatus(null, undefined);
    expect(isFocusSilencing()).toBe(false);
  });
});
