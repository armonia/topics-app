/**
 * THE ACCOUNT, AND THE TWO STEPS THAT CREATE ONE, in a single place.
 *
 * There are now TWO surfaces that ask the same three questions ("is an account
 * linked?", "to which address?", "how do I get one?"): the Settings section and
 * the panel the identity chip opens at the bottom of the sidebar. The flow is
 * six lines of fetch and a two-state machine, which is exactly the size of
 * thing that gets copied instead of shared, and then diverges on the first
 * refusal code somebody handles on one side only.
 *
 * WHAT IT KNOWS AND WHAT IT DOES NOT. It knows the state of the link, which
 * step of the sign-in the person is on, and why the last gesture was refused.
 * It draws nothing and it asks nothing: unlinking is destructive and its
 * confirmation belongs to the surface, the only one that knows whether it can
 * afford a modal.
 *
 * ONE ACCOUNT PER MACHINE, SO EVERY SURFACE HEARS ABOUT IT. Signing in from the
 * dropdown has to update the Settings section behind it, or the two disagree
 * until a reload. The event has the same shape the device list already uses, so
 * there is one mechanism here and not two.
 *
 * A SINGLE VERB FOR SIGN IN AND SIGN UP, deliberately: the service sends a code
 * to an address whether or not that address was already known, so an interface
 * asking people to choose between "log in" and "register" would be asking a
 * question only the server can answer.
 */
import { useCallback, useEffect, useState } from 'react';
import { chiaveErrore as errorKey, type AccountState } from '@/components/Settings/accountState';

/** Fired after a link or an unlink: every open surface reloads its state. */
export const ACCOUNT_CHANGED = 'topics:account-changed';

/** Which of the two steps is on screen. The address survives into the second
 *  one because that is what "go back" restores, and what the code is checked
 *  against. */
export type AccountStep = { phase: 'address' } | { phase: 'code'; email: string };

export interface AccountLink {
  /** `null` while the first read is in flight, or when the server did not
   *  answer at all: nothing is drawn about a state nobody knows. */
  state: AccountState | null;
  step: AccountStep;
  email: string;
  code: string;
  /** The i18n key of the last refusal, `null` when there is nothing to say. */
  error: string | null;
  /** A gesture is in flight: the buttons go quiet rather than queueing. */
  busy: boolean;
  setEmail: (v: string) => void;
  setCode: (v: string) => void;
  /** Step one: ask the service for a code. Moves to step two if it went. */
  askCode: () => Promise<void>;
  /** Step two: hand the code back. Every surface reloads if it went. */
  verify: () => Promise<void>;
  /** Back to the address, keeping what was typed: a wrong letter should not
   *  cost the whole flow. */
  back: () => void;
  /**
   * Detach the account. The caller asks the human first.
   *
   * It ANSWERS with the i18n key of the refusal (`null` when it went). The
   * `error` state alone was not enough for the sidebar: confirming closes the
   * popover that would have drawn it, so the reason had to be able to travel
   * somewhere else. The caller decides where.
   */
  unlink: () => Promise<string | null>;
  reload: () => Promise<void>;
}

/** What a request left behind: it went, or the phrase that says why not. The
 *  key is RETURNED as well as stored, because a caller whose surface is about
 *  to be dismissed cannot read it from the state afterwards. */
interface Sent { ok: boolean; error: string | null }

export function useAccountLink(): AccountLink {
  const [state, setState] = useState<AccountState | null>(null);
  const [step, setStep] = useState<AccountStep>({ phase: 'address' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/account', { credentials: 'same-origin' });
      setState(r.ok ? ((await r.json()) as AccountState) : null);
    } catch {
      // The route is local: if it does not answer the server is down, and the
      // surface hides itself instead of showing an invented state.
      setState(null);
    }
  }, []);

  useEffect(() => {
    const ask = () => { void reload(); };
    // After the first paint: nobody needs the account state in the first frame,
    // and a synchronous state write on mount is what `set-state-in-effect`
    // flags.
    const first = setTimeout(ask, 0);
    window.addEventListener(ACCOUNT_CHANGED, ask);
    return () => {
      clearTimeout(first);
      window.removeEventListener(ACCOUNT_CHANGED, ask);
    };
  }, [reload]);


  /** The one place a response becomes "it went" or "here is why not". */
  const send = useCallback(async (path: string, method: string, payload?: unknown): Promise<Sent> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const b = (await r.json().catch(() => null)) as { ok?: boolean; code?: string } | null;
      if (!r.ok || b?.ok === false) {
        const key = errorKey(b?.code);
        setError(key);
        return { ok: false, error: key };
      }
      return { ok: true, error: null };
    } catch {
      const key = errorKey('service_unreachable');
      setError(key);
      return { ok: false, error: key };
    } finally {
      setBusy(false);
    }
  }, []);

  const askCode = useCallback(async () => {
    const address = email.trim();
    if (!address) return;
    if ((await send('/api/auth/account/code', 'POST', { email: address })).ok) {
      setStep({ phase: 'code', email: address });
      setCode('');
    }
  }, [email, send]);

  const verify = useCallback(async () => {
    if (step.phase !== 'code' || !code.trim()) return;
    if ((await send('/api/auth/account/verify', 'POST', { email: step.email, code: code.trim() })).ok) {
      setStep({ phase: 'address' });
      setCode('');
      // The event reloads THIS hook too, through its own listener: reloading
      // here as well would be the same read fired twice on every sign-in.
      window.dispatchEvent(new Event(ACCOUNT_CHANGED));
    }
  }, [step, code, send]);

  const back = useCallback(() => {
    setStep({ phase: 'address' });
    setError(null);
  }, []);

  const unlink = useCallback(async () => {
    const outcome = await send('/api/auth/account', 'DELETE');
    if (outcome.ok) window.dispatchEvent(new Event(ACCOUNT_CHANGED));
    return outcome.error;
  }, [send]);

  return {
    state, step, email, code, error, busy,
    setEmail, setCode, askCode, verify, back, unlink, reload,
  };
}
