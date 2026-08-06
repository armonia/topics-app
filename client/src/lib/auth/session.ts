// L'identità di QUESTO dispositivo, e come si vede.
//
// Vive fuori da React perché a incontrare un rifiuto è la fetch, non un
// componente: `api.ts` è la strada di tutte le chiamate `/api`, e il WebSocket
// non può leggere lo stato HTTP del proprio upgrade — quindi la diagnosi la
// porta la fetch, che invece lo vede. È la stessa forma del vecchio segnale di
// pairing, e la lezione per cui esiste: uno stato senza uscita non è un'attesa,
// è un vicolo cieco. Il pairing precedente FUNZIONAVA e non è mai servito a
// nessuno perché niente a schermo lo diceva.

export type SessionState =
  /** Non lo sappiamo ancora: la prima interrogazione non è tornata. */
  | { status: 'loading' }
  /** Dentro. `name` è ciò che si mostra sopra la status bar. */
  | { status: 'paired'; as: 'loopback' | 'device'; name: string; deviceId?: string; role: 'owner' | 'guest' }
  /** Fuori, e si può rimediare: `reason` decide cosa dice la schermata. */
  | { status: 'unpaired'; reason: 'not_paired' | 'revoked' | 'expired' };

let state: SessionState = { status: 'loading' };
const listeners = new Set<(s: SessionState) => void>();

function emit(next: SessionState): void {
  const same =
    next.status === state.status &&
    (next.status !== 'paired' || (state.status === 'paired' && next.name === state.name));
  if (same) return;
  state = next;
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

/** Chiamato da `api.ts` quando il server rifiuta per IDENTITÀ. Il codice
 *  distingue i tre modi di essere fuori, e la schermata li dice diversamente:
 *  «mai entrato» non è «ti hanno tolto l'accesso». */
export function markUnpaired(code: string | undefined): void {
  const reason =
    code === 'device_revoked' ? 'revoked' : code === 'session_expired' ? 'expired' : 'not_paired';
  emit({ status: 'unpaired', reason });
}

/** Interroga il server su chi siamo. Esente dall'identità lato server: è la
 *  domanda che si fa PRIMA di averla. */
export async function refreshSession(): Promise<SessionState> {
  try {
    const r = await fetch('/api/auth/session', { credentials: 'same-origin' });
    if (!r.ok) { markUnpaired(undefined); return state; }
    const body = await r.json() as {
      paired: boolean; as: 'loopback' | 'device' | null; name: string | null;
      deviceId?: string; code?: string; role?: 'owner' | 'guest';
    };
    if (body.paired && body.as && body.name) {
      emit({
        status: 'paired', as: body.as, name: body.name, deviceId: body.deviceId,
        // Default prudente: se il server non lo dice, si assume il ruolo con
        // MENO poteri. Il contrario — assumere `owner` — mostrerebbe l'app
        // intera a chi non deve vederla, e la schermata sbagliata sarebbe l'unico
        // sintomo di un server vecchio.
        role: body.role === 'guest' ? 'guest' : body.role === 'owner' ? 'owner' : 'guest',
      });
    } else {
      markUnpaired(body.code);
    }
  } catch {
    // Rete giù: non è «non appaiato». Dirlo sarebbe mandare l'utente a
    // riappaiare un dispositivo che è già a posto.
    if (state.status === 'loading') emit({ status: 'loading' });
  }
  return state;
}

/** Test-only: riporta lo stato a zero fra un caso e l'altro. */
export function __resetSessionForTests(): void {
  state = { status: 'loading' };
  listeners.clear();
}
