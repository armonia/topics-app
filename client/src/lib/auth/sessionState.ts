// The state of THIS device's identity: what the screen shows and who hears it.
//
// Its own module so that `apiFetch` (lib/shell/net.ts), which reports an
// identity refusal here, and `refreshSession` (./session.ts), which asks the
// server through `apiFetch`, do not import each other. The why of the whole
// signal is at the top of ./session.ts.

export type SessionState =
  /** Non lo sappiamo ancora: la prima interrogazione non è tornata. */
  | { status: 'loading' }
  /** Dentro. `name` è ciò che si mostra sopra la status bar. */
  | {
      status: 'paired';
      as: 'loopback' | 'device';
      name: string;
      deviceId?: string;
      role: 'owner' | 'guest';
      /** WHICH Topics: see `installationName` on `unpaired`. */
      installationName?: string | null;
      /** La persona a cui il dispositivo appartiene, quando il server la
       *  conosce. È ciò che un giorno prenderà il posto del nome del ferro:
       *  «Attilio» dice più di «iPhone», e con due telefoni dice l'unica cosa
       *  che li accomuna. */
      personId?: string | null;
    }
  /** Fuori, e si può rimediare: `reason` decide cosa dice la schermata. */
  | {
      status: 'unpaired';
      reason: 'not_paired' | 'revoked' | 'expired';
      /**
       * WHICH Topics is asking to be authorised.
       *
       * It lives mostly HERE, on the state of whoever is not yet anybody: the
       * pairing screen is the one asking for an act of trust, and it was the
       * only one unable to say on whose behalf. With a single installation the
       * gap is invisible; with two, "Authorise this device" becomes a question
       * with no subject.
       *
       * Optional because a server older than this client does not send it, and
       * then the screen must stay quiet instead of painting a blank.
       */
      installationName?: string | null;
    };

/**
 * The last answer this device got, kept so the next boot does not start from
 * «loading». Everything drawn from the session — the name chip at the foot of
 * the sidebar first of all — used to appear only when `/api/auth/session`
 * came back, 400-1500 ms after the first paint, and appearing late is a
 * shift: measured 2026-09-03, the two chips beside it slid 265 px to the
 * right. The server's answer still replaces this the moment it lands, and a
 * refusal removes it, so a revoked device is never told it is in for longer
 * than one request. Only `paired` is kept: an unpaired state is not worth
 * remembering, the gate asks again anyway.
 */
const LAST_PAIRED_KEY = 'topics-session-last-paired';
function readLastPaired(): SessionState | null {
  try {
    const raw = localStorage.getItem(LAST_PAIRED_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Extract<SessionState, { status: 'paired' }>> | null;
    if (!p || p.status !== 'paired' || typeof p.name !== 'string') return null;
    if (p.as !== 'loopback' && p.as !== 'device') return null;
    return {
      status: 'paired', as: p.as, name: p.name, deviceId: p.deviceId,
      role: p.role === 'owner' ? 'owner' : 'guest',
      installationName: p.installationName ?? null,
      personId: p.personId ?? null,
    };
  } catch {
    return null;
  }
}
function rememberSession(next: SessionState): void {
  try {
    if (next.status === 'paired') localStorage.setItem(LAST_PAIRED_KEY, JSON.stringify(next));
    else if (next.status === 'unpaired') localStorage.removeItem(LAST_PAIRED_KEY);
  } catch { /* storage denied: the next boot just starts from «loading» */ }
}

let state: SessionState = readLastPaired() ?? { status: 'loading' };
const listeners = new Set<(s: SessionState) => void>();

/**
 * Uguali vuol dire uguali in TUTTO ciò che qualcuno guarda, non solo nel nome.
 *
 * La versione di prima confrontava `status` e, per `paired`, il solo `name`. Un
 * cambio di RUOLO a parità di nome non raggiungeva nessuno — e il ruolo è ciò
 * su cui `SessionRoot` decide se montare l'app o la vista dell'ospite. Finché il
 * ruolo si fissava all'approvazione e non cambiava più, il difetto restava
 * dormiente; con persone e organizzazioni un cambio di appartenenza È un cambio
 * di ruolo, quindi diventa la norma. Stessa storia per `reason`: passare da
 * «mai entrato» a «revocato» lascia `status` fermo su `unpaired`, e il cartello
 * avrebbe continuato a dire la frase sbagliata.
 *
 * Il confronto resta esplicito campo per campo invece di serializzare: una
 * uguaglianza che dipende dall'ordine delle chiavi è una uguaglianza che prima o
 * poi mente.
 */
function sameState(a: SessionState, b: SessionState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'paired' && b.status === 'paired') {
    return a.name === b.name && a.role === b.role && a.as === b.as
      && a.deviceId === b.deviceId && a.personId === b.personId
      && a.installationName === b.installationName;
  }
  // The NAME too, not just the reason: it is what the pairing screen paints,
  // so a new name at the same reason must reach whoever is looking. An
  // equality that ignores a field somebody displays is an update that never
  // arrives.
  if (a.status === 'unpaired' && b.status === 'unpaired') {
    return a.reason === b.reason && a.installationName === b.installationName;
  }
  return true;
}

function emit(next: SessionState): void {
  if (sameState(next, state)) return;
  state = next;
  rememberSession(state);
  for (const fn of listeners) fn(state);
}

export function getSession(): SessionState {
  return state;
}

export function subscribeSession(fn: (s: SessionState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => { listeners.delete(fn); };
}

/** Called by `apiFetch` (lib/shell/net.ts) when the server refuses for
 *  IDENTITY. The code tells apart the three ways of being out, and the screen
 *  words them differently: "never in" is not "your access was taken away". */
export function markUnpaired(code: string | undefined, installationName?: string | null): void {
  const reason =
    code === 'device_revoked' ? 'revoked' : code === 'session_expired' ? 'expired' : 'not_paired';
  // The name is kept when the new answer does not carry it: `apiFetch` calls
  // this from the refusal of ANY request, which has no name in it. Clearing it
  // there would wipe the heading off the screen on the first 401, exactly when
  // it is needed.
  const previousName = state.status === 'unpaired' ? state.installationName : undefined;
  emit({
    status: 'unpaired', reason,
    installationName: installationName !== undefined ? installationName : previousName,
  });
}

/** Test-only: riporta lo stato a zero fra un caso e l'altro. */
export function __resetSessionForTests(): void {
  state = { status: 'loading' };
  listeners.clear();
  try { localStorage.removeItem(LAST_PAIRED_KEY); } catch { /* no storage in this runtime */ }
}

/** For `refreshSession` (./session.ts): the one other writer of the state. */
export { emit as publishSession };
