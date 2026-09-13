import { lazy, Suspense, useEffect, useState } from 'react';
import { getSession, refreshSession, subscribeSession, type SessionState } from '@/lib/auth/session';
import { MODAL_LAYER } from '@/lib/modalStyles';
import { PairingGate } from '../Auth/PairingGate';

// THE GUEST SCREEN IS A CHUNK OF ITS OWN. It replaces the whole app for a
// guest, so an owner never draws a pixel of it, and it is never in anybody's
// first frame: while the session is still `loading` this root mounts the app.
// As a static import it sat in the eager entry with `GuestCard` and
// `guestStart` behind it (measured 2026-09-13: 9.2 KB raw of the entry chunk,
// 2.2 KB of it added by the delegated agent start), parsed on every boot of
// every owner window. A guest now pays one small request after the session
// answers; the owner pays nothing.
//
// Destructured on purpose, not `.then(m => ...)`: knip reads a bare `import()`
// as opaque and every export of the module would count as used
// (`check:deadcode-blindspots`).
const GuestView = lazy(async () => {
  const { GuestView: Component } = await import('./GuestView');
  return { default: Component };
});

/**
 * Chi entra decide COSA si monta, non cosa si vede.
 *
 * La differenza è tutta qui, ed è costata una prova sbagliata: montare la vista
 * ospite come un pannello SOPRA l'app la copre ma non la spegne. Misurato — con
 * l'app viva sotto, un ospite produceva una schermata piena di «non disponibile
 * per un ospite», perché ogni suo pezzo continuava a chiedere al server cose che
 * il gate nega. Un ospite che vede errori pensa che sia rotto, non che non sia
 * roba sua. E il rumore non è solo estetico: sono richieste vere, rifiutate,
 * ripetute.
 *
 * Quindi la decisione sta alla RADICE, prima di `<App/>`:
 *   non autorizzato → il cancello, e basta;
 *   ospite          → la sua vista, e basta;
 *   proprietario    → l'app.
 *
 * Ed è un punto solo perché la domanda è una sola: due posti che decidono chi
 * vede cosa, prima o poi, dicono cose diverse.
 */
export function SessionRoot({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionState>(getSession);

  useEffect(() => subscribeSession(setSession), []);
  useEffect(() => { void refreshSession(); }, []);

  // Finché non si sa, si monta l'app: sul computer — cioè il caso normale — la
  // risposta è sempre «sei dentro», e trattenere il primo paint per aspettarla
  // farebbe pagare a tutti un ritardo che serve a un caso raro. Il cancello
  // subentra se la risposta smentisce.
  if (session.status === 'loading') return <>{children}</>;
  if (session.status === 'unpaired') return <PairingGate session={session} />;

  // Il DEFAULT è invertito rispetto a prima, ed è una differenza di sicurezza.
  //
  // Il codice di partenza diceva «se è `guest` mostra la vista ospite,
  // ALTRIMENTI monta l'app»: cioè qualunque ruolo non previsto — un valore
  // nuovo, un server più avanti del client, un campo che un giorno arriva
  // vuoto — cadeva dalla parte PERMISSIVA per omissione. Il verso giusto è
  // l'opposto: si monta l'app solo a chi è riconosciuto proprietario, e tutto
  // il resto è confinato.
  //
  // Sbagliare da questa parte si vede e si corregge (qualcuno vede meno di
  // quanto dovrebbe, e lo dice); sbagliare dall'altra non si vede affatto.
  if (session.role === 'owner') return <>{children}</>;
  // The placeholder is the guest screen's own empty surface, not `null`: the
  // app has just been unmounted, and a bare page for the length of one request
  // would read as a crash before the list arrives.
  return (
    <Suspense fallback={<div className={`fixed inset-0 ${MODAL_LAYER} bg-app-bg`} />}>
      <GuestView deviceName={session.name} />
    </Suspense>
  );
}
