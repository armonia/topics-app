import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { Smartphone } from 'lucide-react';

/**
 * Il cartello che compare sulla macchina GIÀ fidata quando un dispositivo nuovo
 * chiede accesso.
 *
 * Arriva via WebSocket e non da un pannello di impostazioni, perché la richiesta
 * deve raggiungere l'utente OVUNQUE stia guardando: chi arriva col telefono in
 * mano è fermo su una schermata d'attesa, e se la conferma vivesse dentro un
 * menù resterebbe lì a fissarla senza sapere dove andare.
 *
 * Il codice si MOSTRA, non si digita: serve a chi approva per essere certo di
 * autorizzare quel telefono e non una richiesta arrivata nello stesso istante da
 * qualcun altro sulla stessa rete.
 */
interface Richiesta {
  id: string;
  code: string;
  name: string;
  ip: string | null;
}

export function PairingApproval() {
  const tr = useT();
  const [richieste, setRichieste] = useState<Richiesta[]>([]);
  const [inCorso, setInCorso] = useState<string | null>(null);
  /** Chi sta scrivendo il nome di un'altra persona, e cosa ha scritto. */
  const [altrui, setAltrui] = useState<{ id: string; nome: string } | null>(null);

  useEffect(() => {
    // Stato iniziale: una richiesta può essere arrivata mentre questa finestra
    // era chiusa o ricaricata.
    void fetch('/api/auth/pair/pending', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((b: { requests?: Richiesta[] }) => setRichieste(b.requests ?? []))
      .catch(() => { /* nessuna identità o rete giù: niente da mostrare */ });

    const onRequested = (e: Event) => {
      const d = (e as CustomEvent).detail as Richiesta;
      setRichieste((prev) => (prev.some((r) => r.id === d.id) ? prev : [...prev, d]));
    };
    const onResolved = (e: Event) => {
      const d = (e as CustomEvent).detail as { requestId: string };
      setRichieste((prev) => prev.filter((r) => r.id !== d.requestId));
    };
    window.addEventListener('topics:auth-pair-requested', onRequested);
    window.addEventListener('topics:auth-pair-resolved', onResolved);
    return () => {
      window.removeEventListener('topics:auth-pair-requested', onRequested);
      window.removeEventListener('topics:auth-pair-resolved', onResolved);
    };
  }, []);

  /**
   * DI CHI È il dispositivo, ed è l'unico momento in cui ha senso chiederlo: è
   * la stessa occhiata in cui si confronta il codice.
   *
   * Il ruolo NON si manda più. Discende dall'essere proprietari
   * dell'installazione, e chiederlo a parte inviterebbe a contraddire il
   * modello: si potrebbe dire «proprietario» di un dispositivo attribuito a un
   * estraneo, e a quel punto quale delle due frasi sarebbe quella vera?
   *
   * Il passaggio precedente resta utile da ricordare. Finché questo cartello
   * mandava il solo `requestId`, ogni dispositivo autorizzato dall'app nasceva
   * proprietario e un ospite era raggiungibile solo con `curl`: la condivisione
   * era irraggiungibile a cascata, perché `ShareControl` diceva per sempre
   * «Nessun ospite».
   */
  const rispondi = async (
    id: string,
    approva: boolean,
    chi?: { personName: string } | { mio: true },
  ) => {
    setInCorso(id);
    try {
      // Si manda DI CHI È, non che ruolo ha: il ruolo discende dall'essere
      // proprietari dell'installazione, e chiederlo a parte inviterebbe a
      // contraddire il modello — si potrebbe dire «proprietario» di un
      // dispositivo attribuito a un estraneo, e allora quale delle due frasi
      // sarebbe quella vera?
      const corpo = !approva
        ? { requestId: id }
        : chi && 'personName' in chi
          ? { requestId: id, personName: chi.personName }
          : { requestId: id };
      await fetch(`/api/auth/pair/${approva ? 'approve' : 'deny'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(corpo),
      });
      setRichieste((prev) => prev.filter((r) => r.id !== id));
    } finally {
      setInCorso(null);
    }
  };

  if (richieste.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9998] flex w-[320px] flex-col gap-2">
      {richieste.map((r) => (
        <div key={r.id} className="rounded-xl border border-app-border bg-surface p-3 shadow-lg">
          <div className="flex items-center gap-2">
            <Smartphone size={14} className="text-app-text-secondary" />
            <span className="text-[13px] font-medium text-app-text">{r.name} chiede accesso</span>
          </div>
          {r.ip && <div className="mt-0.5 text-[11px] text-app-text-muted">{tr('pair.from', { ip: r.ip.replace(/^::ffff:/, '') })}</div>}

          <div className="mt-3 rounded-lg bg-app-bg py-2 text-center font-mono text-[22px] font-semibold tracking-[0.1em] text-app-text">
            {r.code}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-app-text-secondary">
            {tr('pair.verifyCode')}
          </p>

          {/* La domanda è «di chi è», e ha DUE risposte distinte invece di un
              interruttore: la differenza fra il proprio telefono e quello di un
              altro è la cosa più importante che questo cartello dice, e un
              interruttore la renderebbe una preferenza da notare invece di una
              scelta da fare. Il pieno resta «È mio», che è il caso normale.
              Il ruolo non compare: una persona nuova non è proprietaria, e da
              lì discende che veda solo ciò che le si condivide. */}
          <div className="mt-3 flex gap-2">
            <button
              disabled={inCorso === r.id}
              onClick={() => void rispondi(r.id, false)}
              className="flex-1 rounded-lg border border-app-border px-3 py-1.5 text-[12px] text-app-text hover:bg-app-bg disabled:opacity-50"
            >
              Nega
            </button>
            <button
              disabled={inCorso === r.id}
              onClick={() => void rispondi(r.id, true, { mio: true })}
              className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              data-testid="pair-approve-owner"
            >
              {tr('pair.mine')}
            </button>
          </div>

          {/* The exact twin of the defect in `DevicesSection`: with the state
              at null and a missing `r.id` the comparison is true and the line
              below dereferences it. Check the object first, then the id. */}
          {altrui && altrui.id === r.id ? (
            <div className="mt-2 flex gap-1.5">
              <input
                autoFocus
                value={altrui.nome}
                onChange={(e) => setAltrui({ id: r.id, nome: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && altrui.nome.trim()) {
                    void rispondi(r.id, true, { personName: altrui.nome });
                    setAltrui(null);
                  }
                  if (e.key === 'Escape') setAltrui(null);
                }}
                placeholder={tr('pair.whose')}
                aria-label={tr('pair.personName')}
                className="min-w-0 flex-1 rounded-lg border border-app-border bg-app-bg px-2 py-1.5 text-[12px] text-app-text outline-none focus:border-primary"
              />
              <button
                disabled={inCorso === r.id || !altrui.nome.trim()}
                onClick={() => { void rispondi(r.id, true, { personName: altrui.nome }); setAltrui(null); }}
                className="flex-shrink-0 rounded-lg border border-app-border px-2.5 py-1.5 text-[12px] text-app-text hover:bg-app-bg disabled:opacity-50"
                data-testid="pair-approve-guest"
              >
                Autorizza
              </button>
            </div>
          ) : (
            <button
              disabled={inCorso === r.id}
              onClick={() => setAltrui({ id: r.id, nome: '' })}
              className="mt-2 w-full rounded-lg border border-app-border px-3 py-1.5 text-[12px] text-app-text-secondary hover:bg-app-bg disabled:opacity-50"
            >
              {tr('pair.someoneElse')}
            </button>
          )}
          <p className="mt-1.5 text-[10px] leading-snug text-app-text-muted">
            {tr('pair.guestBlurb')}
          </p>
        </div>
      ))}
    </div>
  );
}
