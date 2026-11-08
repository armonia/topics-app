// The state of THIS device's identity: what the screen shows and who hears it.
//
// Its own module so that `apiFetch` (lib/shell/net.ts), which reports an
// identity refusal here, and `refreshSession` (./session.ts), which asks the
// server through `apiFetch`, do not import each other. The why of the whole
// signal is at the top of ./session.ts.

export type SessionState =
  /** Not known yet: the first question has not come back. */
  | { status: 'loading' }
  /** In. `name` is what shows above the status bar. */
  | {
      status: 'paired';
      as: 'loopback' | 'device';
      name: string;
      deviceId?: string;
      role: 'owner' | 'guest';
      /** WHICH Topics: see `installationName` on `unpaired`. */
      installationName?: string | null;
      /** The person the device belongs to, when the server knows it. It is
       *  what will one day replace the hardware's name: a person's name says
       *  more than "iPhone", and with two phones it says the one thing they
       *  share. */
      personId?: string | null;
      /** The server can run a command for its owner (Run under a code block of a reply): not on Windows. */
      commandShell?: boolean;
    }
  /** Out, and it can be fixed: `reason` decides what the screen says. */
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
      commandShell: p.commandShell === true,
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
 * Equal means equal in EVERYTHING somebody looks at, not just the name.
 *
 * The earlier version compared `status` and, for `paired`, only `name`. A ROLE
 * change under the same name reached nobody, and the role is what
 * `SessionRoot` uses to mount the app or the guest view. While the role was set
 * at approval and never changed, the defect slept; with people and
 * organisations a change of membership IS a change of role, so it becomes the
 * norm. Same story for `reason`: going from "never in" to "revoked" leaves
 * `status` on `unpaired`, and the screen would have kept saying the wrong
 * sentence.
 *
 * The comparison stays explicit field by field instead of serialising: an
 * equality that depends on key order is an equality that sooner or later lies.
 */
function sameState(a: SessionState, b: SessionState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === 'paired' && b.status === 'paired') {
    return a.name === b.name && a.role === b.role && a.as === b.as
      && a.deviceId === b.deviceId && a.personId === b.personId
      && a.installationName === b.installationName
      && a.commandShell === b.commandShell;
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

/** Test-only: reset the state between cases. */
export function __resetSessionForTests(): void {
  state = { status: 'loading' };
  listeners.clear();
  try { localStorage.removeItem(LAST_PAIRED_KEY); } catch { /* no storage in this runtime */ }
}

/** For `refreshSession` (./session.ts): the one other writer of the state. */
export { emit as publishSession };
