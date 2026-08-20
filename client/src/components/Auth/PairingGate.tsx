import { useEffect, useRef, useState } from 'react';
import { refreshSession, type SessionState } from '@/lib/auth/session';
import { MODAL_LAYER } from '@/lib/modalStyles';
import { useT } from '@/hooks/useT';

/**
 * La schermata che vede un dispositivo NON appaiato.
 *
 * Il verso: qui si MOSTRA un codice, non si chiede di inserirne uno. Chi approva
 * è la macchina che ha già la sessione, e il codice serve a lei per essere certa
 * di autorizzare QUESTO telefono e non una richiesta arrivata nello stesso
 * momento da qualcun altro. Per questo non c'è un campo di input: non c'è niente
 * da indovinare, e non serve difendere nulla dal brute-force.
 *
 * Perché è a schermo intero e non un cartello in un angolo: senza identità
 * l'app non ha dati da mostrare, e un'attesa silenziosa dietro un'interfaccia
 * vuota è esattamente il vicolo cieco che il pairing precedente produceva —
 * funzionava, ma niente lo diceva, e nessuno l'ha mai usato.
 */
export function PairingGate({ session }: { session: SessionState }) {
  const t = useT();
  const [code, setCode] = useState<string | null>(null);
  // Lo stato tiene il MOTIVO, non la frase. Una frase tradotta messa qui
  // resterebbe nella lingua di quando è stata scritta anche dopo un cambio
  // di lingua — e obbligherebbe l'effetto a dipendere da `t`, cioè a
  // ripartire ogni volta che la lingua cambia.
  const [error, setError] = useState<'unreachable' | null>(null);
  const [denied, setDenied] = useState(false);
  const requestIdRef = useRef<string | null>(null);
  const claimRef = useRef<string>('');

  // Il titolo INVITA quando è un primo accesso, e rifiuta solo quando c'è un
  // rifiuto vero. Diceva «Dispositivo non autorizzato» anche alla prima
  // apertura: la schermata che serve ad autorizzarti apriva dicendoti che non
  // sei autorizzato, e chi la leggeva concludeva che fosse un guasto invece
  // che un passo. Visto succedere, sul primo telefono che l'ha aperta.
  const revocato = session.status === 'unpaired' && session.reason === 'revoked';
  const scaduto = session.status === 'unpaired' && session.reason === 'expired';
  const titolo = t(revocato ? 'pair.title.revoked' : scaduto ? 'pair.title.expired' : 'pair.title.new');
  const spiegazione = t(revocato ? 'pair.blurb.revoked' : 'pair.blurb.new');

  // Chiede un codice e poi aspetta. Il polling è a 2s: il gesto umano dall'altra
  // parte dura secondi, non millisecondi, e una connessione persistente qui
  // sarebbe complessità per niente.
  useEffect(() => {
    let vivo = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function avvia() {
      setError(null);
      setDenied(false);
      try {
        const r = await fetch('/api/auth/pair/request', { method: 'POST', credentials: 'same-origin' });
        if (!r.ok) throw new Error('richiesta rifiutata');
        const body = await r.json() as { requestId: string; code: string; claim?: string };
        if (!vivo) return;
        requestIdRef.current = body.requestId;
        // Il segreto di ritiro: torna solo qui, e da qui non esce più. Senza,
        // chiunque avesse visto passare il `requestId` poteva incassare il
        // gettone al posto nostro.
        claimRef.current = body.claim ?? '';
        setCode(body.code);
        attendi();
      } catch {
        if (vivo) setError('unreachable');
      }
    }

    async function attendi() {
      if (!vivo || !requestIdRef.current) return;
      try {
        const r = await fetch(
          `/api/auth/pair/status?requestId=${encodeURIComponent(requestIdRef.current)}`
          + `&claim=${encodeURIComponent(claimRef.current)}`,
          { credentials: 'same-origin' },
        );
        const body = await r.json() as { state: 'pending' | 'approved' | 'denied' | 'expired' };
        if (!vivo) return;
        if (body.state === 'approved') {
          // Il cookie è arrivato con questa risposta: si ricarica per ripartire
          // pulito, invece di rianimare uno stato nato senza identità.
          window.location.reload();
          return;
        }
        if (body.state === 'denied') { setDenied(true); setCode(null); return; }
        if (body.state === 'expired') { void avvia(); return; }
      } catch {
        // Un buco di rete non è un rifiuto: si riprova.
      }
      timer = setTimeout(attendi, 2000);
    }

    void avvia();
    return () => { vivo = false; if (timer) clearTimeout(timer); };
  }, [session.status]);

  return (
    // Il piano si dichiara con la costante, non con un 9999 scritto a mano —
    // che per giunta è il piano dei POPOVER, non quello di una superficie che
    // deve coprire tutto. Oggi non si nota, perché `SessionRoot` monta questo
    // cancello INVECE dell'app e non c'è niente sotto con cui competere: ma è
    // proprio questo che rende il numero a mano insidioso, il giorno in cui
    // qualcosa (un toast, un overlay di sviluppo, un portal condiviso) si
    // monta accanto e vince un pareggio per ordine nel DOM.
    <div className={`fixed inset-0 ${MODAL_LAYER} flex items-center justify-center bg-app-bg px-6`}>
      <div className="w-full max-w-sm text-center">
        <h1 className="text-[19px] font-semibold text-app-text">{titolo}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-app-text-secondary">{spiegazione}</p>

        {error && (
          <p className="mt-6 rounded-lg border border-app-border bg-surface px-4 py-3 text-[13px] text-app-text-secondary">
            {t('pair.unreachable')}
          </p>
        )}

        {denied && (
          <div className="mt-6">
            <p className="text-[13px] text-app-text-secondary">{t('pair.denied')}</p>
            <button
              onClick={() => { setDenied(false); setCode(null); void refreshSession(); }}
              className="mt-3 rounded-lg border border-app-border px-4 py-2 text-[13px] text-app-text hover:bg-surface"
            >
              {t('pair.retry')}
            </button>
          </div>
        )}

        {code && !denied && (
          <>
            <div
              className="mt-8 select-all font-mono text-[34px] font-semibold tracking-[0.12em] text-app-text"
              aria-label={t('pair.code.aria', { code: code.split('').join(' ') })}
            >
              {code}
            </div>
            <p className="mt-4 text-[13px] leading-relaxed text-app-text-secondary">
              {t('pair.codeHint')}
              <br />
              {t('pair.checkThenTap')} <span className="text-app-text">{t('pair.approve')}</span>.
            </p>
            <div className="mt-6 flex items-center justify-center gap-2 text-[12px] text-app-text-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              {t('pair.waiting')}
            </div>
          </>
        )}

        {!code && !error && !denied && (
          <div className="mt-8 text-[13px] text-app-text-muted">{t('pair.preparing')}</div>
        )}
      </div>
    </div>
  );
}
