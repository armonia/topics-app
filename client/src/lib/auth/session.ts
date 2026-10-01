// L'identità di QUESTO dispositivo, e come si vede.
//
// It lives outside React because what meets a refusal is the fetch, not a
// component: `apiFetch` (lib/shell/net.ts) is the door of every `/api` call,
// and the WebSocket cannot read the HTTP status of its own upgrade, so the
// diagnosis rides on the fetch, which can.
// È la stessa forma del vecchio segnale di
// pairing, e la lezione per cui esiste: uno stato senza uscita non è un'attesa,
// è un vicolo cieco. Il pairing precedente FUNZIONAVA e non è mai servito a
// nessuno perché niente a schermo lo diceva.

import { apiFetch } from '../shell/net';
import { getSession, markUnpaired, publishSession, type SessionState } from './sessionState';

export { getSession, subscribeSession, markUnpaired, __resetSessionForTests, type SessionState } from './sessionState';

/** Interroga il server su chi siamo. Esente dall'identità lato server: è la
 *  domanda che si fa PRIMA di averla. */
export async function refreshSession(): Promise<SessionState> {
  try {
    const r = await apiFetch('/api/auth/session', { credentials: 'same-origin' });
    if (!r.ok) { markUnpaired(undefined); return getSession(); }
    const body = await r.json() as {
      paired: boolean; as: 'loopback' | 'device' | null; name: string | null;
      deviceId?: string; code?: string; role?: 'owner' | 'guest'; personId?: string | null;
      installationName?: string | null;
    };
    if (body.paired && body.as && body.name) {
      publishSession({
        status: 'paired', as: body.as, name: body.name, deviceId: body.deviceId,
        personId: body.personId ?? null,
        installationName: body.installationName ?? null,
        // Default prudente: se il server non lo dice, si assume il ruolo con
        // MENO poteri. Il contrario — assumere `owner` — mostrerebbe l'app
        // intera a chi non deve vederla, e la schermata sbagliata sarebbe l'unico
        // sintomo di un server vecchio.
        role: body.role === 'guest' ? 'guest' : body.role === 'owner' ? 'owner' : 'guest',
      });
    } else {
      // The name arrives FROM HERE, the only call that carries it: this route
      // is identity-exempt on purpose, it is the question asked before being
      // anybody. `?? null` and not `undefined`: a server that omits it states
      // "I do not know", which differs from "I did not speak".
      markUnpaired(body.code, body.installationName ?? null);
    }
  } catch {
    // Rete giù: non è «non appaiato». Dirlo sarebbe mandare l'utente a
    // riappaiare un dispositivo che è già a posto.
    if (getSession().status === 'loading') publishSession({ status: 'loading' });
  }
  return getSession();
}
