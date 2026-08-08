// Focus / Do-Not-Disturb gate — is the OS telling us to stay quiet?
//
// The web platform has NO way to read "the user is in DND/Focus": the datum lives
// only in the native shell. Under Tauri the Rust `focus_status` command reads
// macOS's active Focus assertion; a background watcher PUSHES changes into the
// webview via `window.__topicsFocusChanged(active, supported, reason)` (the shell's
// eval-hook convention — no @tauri-apps/event dependency). This module caches the
// last known state so callers can consult it SYNCHRONOUSLY (the completion
// notifier fires from a sync WS handler).
//
// SAFE DEFAULT, everywhere: when the state is unknown — web/PWA, non-macOS, or
// macOS without read access — `supported` is false and we NEVER suppress. Losing
// a banner because we guessed "probably DND" is worse than one banner during
// Focus; silence is only ever asserted on a POSITIVE, supported reading.

import { shellKind } from './index';
import { tauriInvoke } from './tauri';

/**
 * PERCHÉ il gate non sa lo stato — e non è una sfumatura.
 *
 * `'denied'` è l'unico caso in cui l'utente può fare qualcosa (concedere
 * l'Accesso completo al disco). `'absent'` vuol dire che il file delle
 * asserzioni non esiste, cioè che su questo Mac non è mai stato impostato un
 * Focus: il gate funziona, semplicemente non ha nulla da silenziare, e
 * mostrarne un avviso vorrebbe dire chiedere il permesso più invasivo di macOS
 * per niente. `'unknown'` copre i gusci vecchi, che il motivo non lo mandano.
 */
export type FocusReason = 'ok' | 'denied' | 'absent' | 'unknown';

interface FocusStatus {
  /** The host can actually determine the Focus state. False ⇒ don't gate. */
  supported: boolean;
  /** A Focus / Do-Not-Disturb is currently on. Only meaningful when supported. */
  active: boolean;
  reason: FocusReason;
}

// Optimistic default: not supported ⇒ the gate is transparent until the first
// real reading lands (or forever, on web).
let cache: FocusStatus = { supported: false, active: false, reason: 'unknown' };
/** Una lettura è già tornata? Serve a non diagnosticare «bloccato» mentre la
 *  prima query è ancora in volo — un avviso che poi si smentisce è peggio del
 *  nulla. */
let queried = false;

/**
 * True iff the OS is in a Focus/DND we can positively confirm — the one case
 * where the completion notifier stays silent. Sync + allocation-free so it's
 * cheap to call on the hot notification path.
 */
export function isFocusSilencing(): boolean {
  return cache.supported && cache.active;
}

/** Record a new reading. The single writer of the cache — used both by the
 *  eager query and (as the `window.__topicsFocusChanged` hook) by the native
 *  watcher. Coerces to booleans so a malformed push can't poison the gate.
 *
 *  `reason` è arrivato dopo: un guscio più vecchio del bundle manda solo i due
 *  booleani. In quel caso lo si DEDUCE con la vecchia regola (`supported=false`
 *  ⇒ bloccato), che è esattamente il comportamento di prima — inventare
 *  «assente» su un dato che non abbiamo spegnerebbe una diagnosi vera. */
export function applyFocusStatus(active: unknown, supported: unknown, reason?: unknown): void {
  const ok = !!supported;
  const known: FocusReason[] = ['ok', 'denied', 'absent'];
  const parsed = known.find((r) => r === reason)
    ?? (ok ? 'ok' : 'denied');
  cache = { supported: ok, active: !!active, reason: parsed };
  queried = true;
}

declare global {
  interface Window {
    /** Installed by initFocusStatus(); called by the Rust focus watcher on change. */
    __topicsFocusChanged?: (active: boolean, supported: boolean, reason?: string) => void;
  }
}

let initialized = false;

/**
 * Wire up the Focus gate. Idempotent; no-op off Tauri (web keeps the safe
 * default forever). Installs the push hook the Rust watcher calls, then does one
 * eager query so the cache is correct without waiting for the first toggle.
 */
export function initFocusStatus(): void {
  if (initialized) return;
  initialized = true;
  if (shellKind !== 'tauri') return;

  window.__topicsFocusChanged = applyFocusStatus;

  void tauriInvoke<FocusStatus>('focus_status')
    .then((s) => {
      if (s && typeof s.supported === 'boolean' && typeof s.active === 'boolean') {
        applyFocusStatus(s.active, s.supported, s.reason);
      }
    })
    .catch(() => {
      // Il default sicuro resta (sconosciuto ⇒ si notifica), ma la lettura È
      // tornata: se fallisce, il gate è bloccato e l'interfaccia deve poterlo
      // dire invece di restare in «attesa» per sempre.
      queried = true;
    });
}

/**
 * Lo stato del gate, per l'INTERFACCIA (non per il percorso caldo delle
 * notifiche, che usa `isFocusSilencing`).
 *
 * Su macOS 26 il file delle asserzioni (`~/Library/DoNotDisturb/DB/`) è protetto
 * da TCC: quando il permesso manca il gate resta trasparente e l'utente riceve
 * banner durante un Focus **senza sapere perché** — la funzione sembra
 * semplicemente non esistere, e vale la pena dirlo.
 *
 * `blocked` è l'unico stato che merita un'azione, ed è per questo che ora
 * dipende dal MOTIVO e non più da `supported`. Prima era `supported ? 'active'
 * : 'blocked'`, e `supported=false` arrivava sia dal permesso negato sia dal
 * file inesistente: su un Mac dove nessuno ha mai impostato un Focus l'app
 * chiedeva l'Accesso completo al disco — il permesso più invasivo di macOS —
 * per una funzione che non aveva niente da silenziare.
 *
 * `'ok'` si chiamava `'active'`, e quel nome mentiva: non ha mai voluto dire
 * «c'è un Focus attivo» (quello è `isFocusSilencing`), ma «il gate funziona».
 */
export type FocusGateState = 'unavailable' | 'pending' | 'blocked' | 'ok';

export function focusGateState(): FocusGateState {
  if (shellKind !== 'tauri') return 'unavailable';
  if (!queried) return 'pending';
  return cache.reason === 'denied' ? 'blocked' : 'ok';
}

/** L'impostazione di sistema da aprire per concedere l'accesso (solo macOS). */
export const FULL_DISK_ACCESS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/** Reset the cached state to the safe default. Test-only. */
export function __resetFocusForTests(): void {
  cache = { supported: false, active: false, reason: 'unknown' };
  queried = false;
}
