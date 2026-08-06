import { useEffect, useState } from 'react';
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
  const [richieste, setRichieste] = useState<Richiesta[]>([]);
  const [inCorso, setInCorso] = useState<string | null>(null);

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

  const rispondi = async (id: string, approva: boolean) => {
    setInCorso(id);
    try {
      await fetch(`/api/auth/pair/${approva ? 'approve' : 'deny'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ requestId: id }),
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
          {r.ip && <div className="mt-0.5 text-[11px] text-app-text-muted">da {r.ip.replace(/^::ffff:/, '')}</div>}

          <div className="mt-3 rounded-lg bg-app-bg py-2 text-center font-mono text-[22px] font-semibold tracking-[0.1em] text-app-text">
            {r.code}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-app-text-secondary">
            Autorizza solo se questo codice è lo stesso mostrato su quel dispositivo.
          </p>

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
              onClick={() => void rispondi(r.id, true)}
              className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              Autorizza
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
