import { Suspense, useEffect, useState } from 'react';
import { getSession, refreshSession, subscribeSession, type SessionState } from '@/lib/auth/session';
import { MODAL_LAYER } from '@/lib/modalStyles';
import { PairingGate } from '../Auth/PairingGate';
import { GuestView } from './guestViewLazy';
import { useT } from '../../hooks/useT';

// The guest screen is a chunk of its own, warmed before the first render when
// the cached session already says guest: see `guestViewLazy`.

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
export function SessionRoot({ children, screenPage = false }: { children: React.ReactNode; screenPage?: boolean }) {
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
  // A device paired as a SCREEN sees the load page and nothing else: on that page it mounts
  // it, anywhere else only a way back to it. The server shuts every other route to it as well.
  if (session.role === 'screen') return screenPage ? <>{children}</> : <ScreenOnlyNotice />;
  // Only a guest that pairs while the app is on screen reaches the fallback: a
  // returning guest finds the chunk warm (`main.tsx`). The placeholder is the
  // guest screen's own empty surface, not `null`: the app has just been
  // unmounted, and a bare page for one request would read as a crash.
  return (
    <Suspense fallback={<div className={`fixed inset-0 ${MODAL_LAYER} bg-app-bg`} />}>
      <GuestView deviceName={session.name} />
    </Suspense>
  );
}

/** What a screen device sees outside the load page: one sentence and the way back. */
function ScreenOnlyNotice() {
  const tr = useT();
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-3 bg-app-bg px-6 text-center text-app-text" data-testid="screen-only-notice">
      <p className="m-0 text-body-lg">{tr('pair.screenOnly')}</p>
      <a href="/schermo" className="rounded-lg border border-app-border px-3 py-1.5 text-compact text-app-text hover:bg-surface">{tr('pair.screenOpen')}</a>
    </div>
  );
}
