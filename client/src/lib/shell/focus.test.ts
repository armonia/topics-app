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
  * @covers QUIET-01
 */
import { describe, test, it, expect, beforeEach } from 'bun:test';
import { isFocusSilencing, applyFocusStatus, focusGateState, __resetFocusForTests } from './focus';

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

// ── Lo stato per l'interfaccia ─────────────────────────────────────────────
//
// `supported: false` sul guscio nativo non è un dettaglio tecnico: vuol dire
// che l'utente riceve banner durante un Focus senza sapere perché. Serve poterlo
// dire — ma solo quando lo si sa davvero, e solo quando c'è qualcosa da fare.
describe('focusGateState', () => {
  beforeEach(() => { __resetFocusForTests(); });

  it('fuori dal guscio nativo non c’è niente da diagnosticare', () => {
    // Nei test `shellKind` non è 'tauri': è il caso web/PWA.
    expect(focusGateState()).toBe('unavailable');
  });

  it('una lettura tornata con supported=true è il gate a posto', () => {
    applyFocusStatus(false, true, 'ok');
    // Fuori da Tauri resta 'unavailable' per costruzione: lo stato si legge
    // solo dove il gate può esistere. È la parte che impedisce di mostrare un
    // avviso sul web, dove non c'è alcun permesso da concedere.
    expect(focusGateState()).toBe('unavailable');
  });

  it('applyFocusStatus segna la lettura come avvenuta', () => {
    // Il flag interno è ciò che distingue «in attesa» da «bloccato»: senza,
    // l'interfaccia mostrerebbe un avviso mentre la prima query è ancora in volo.
    applyFocusStatus(true, true);
    expect(isFocusSilencing()).toBe(true);
    __resetFocusForTests();
    expect(isFocusSilencing()).toBe(false);
  });
});

// ── Il MOTIVO, e perché non basta `supported` ──────────────────────────────
//
// `supported=false` arrivava da due cause diverse fuse in un `.ok()?`: il
// permesso TCC negato e il file delle asserzioni semplicemente inesistente. Il
// pannello dava sempre la colpa al permesso e proponeva l'Accesso completo al
// disco — su un Mac dove nessuno ha mai impostato un Focus, il permesso più
// invasivo di macOS per una funzione che non ha niente da silenziare.
//
// `focusGateState` non è direttamente osservabile fuori da Tauri (torna sempre
// 'unavailable', ed è giusto così), quindi qui si verifica il pezzo che decide:
// come `applyFocusStatus` normalizza il motivo, incluso il guscio vecchio che
// non lo manda.
describe('il motivo della lettura', () => {
  beforeEach(() => { __resetFocusForTests(); });

  it('«file assente» non silenzia e non è un blocco: il gate funziona', () => {
    applyFocusStatus(false, true, 'absent');
    expect(isFocusSilencing()).toBe(false);
  });

  it('«negato» non silenzia mai — il default sicuro resta', () => {
    // Nessun avviso può giustificare un banner perso: senza lettura non si tace.
    applyFocusStatus(true, false, 'denied');
    expect(isFocusSilencing()).toBe(false);
  });

  it('un guscio vecchio manda solo i due booleani: si torna alla vecchia regola', () => {
    // Il bundle può essere più nuovo del .app installato. Senza motivo si
    // DEDUCE (supported=false ⇒ bloccato): inventare «assente» su un dato che
    // non abbiamo spegnerebbe una diagnosi vera.
    applyFocusStatus(false, false);
    expect(isFocusSilencing()).toBe(false);
    applyFocusStatus(true, true);
    expect(isFocusSilencing()).toBe(true);
  });

  it('un motivo sconosciuto non avvelena il gate', () => {
    applyFocusStatus(true, true, 'qualcosa-che-non-esiste');
    expect(isFocusSilencing()).toBe(true);
  });
});
