import { useEffect, useRef, useState } from 'react';
import { refreshSession, type SessionState } from '@/lib/auth/session';
import { attesaRiprova, chiaveFrase, chiaveStato, motivoDaRisposta, type MotivoPairing } from './pairingErrore';
import { MODAL_LAYER } from '@/lib/modalStyles';
import { useT } from '@/hooks/useT';

/** The bundle version, baked in by Vite (`client/vite.config.ts`). */
declare const __APP_VERSION__: string;
const VERSIONE = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

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
  //
  // TWO reasons, not one, because they are different facts with different
  // cures. `unreachable` is a fetch that never returns: machine off, relay
  // down, no network. A CODE is a reply that ARRIVED: the server is there, it
  // understood, and it said no for a reason of its own. Showing "I can't reach
  // Topics" for that sends someone to check a computer that is answering
  // fine, and that is the line this screen printed on every 429.
  const [error, setError] = useState<MotivoPairing | null>(null);
  const [denied, setDenied] = useState(false);
  const requestIdRef = useRef<string | null>(null);
  const claimRef = useRef<string>('');
  /** Failures in a row. Only used to space out the retries. */
  const tentativiRef = useRef(0);
  /**
   * The "retry now" gesture, as an effect DEPENDENCY.
   *
   * A counter is required and `setError(null)` is not enough: the request loop
   * lives inside the effect, and with no changing dependency the effect never
   * restarts. The button would clear the card and leave an empty screen
   * waiting on a timer nobody can see. A button that looks like it acts and
   * does not is worse than no button.
   */
  const [oraRiprova, setOraRiprova] = useState(0);

  // Il titolo INVITA quando è un primo accesso, e rifiuta solo quando c'è un
  // rifiuto vero. Diceva «Dispositivo non autorizzato» anche alla prima
  // apertura: la schermata che serve ad autorizzarti apriva dicendoti che non
  // sei autorizzato, e chi la leggeva concludeva che fosse un guasto invece
  // che un passo. Visto succedere, sul primo telefono che l'ha aperta.
  const revocato = session.status === 'unpaired' && session.reason === 'revoked';
  const scaduto = session.status === 'unpaired' && session.reason === 'expired';
  const titolo = t(revocato ? 'pair.title.revoked' : scaduto ? 'pair.title.expired' : 'pair.title.new');
  const spiegazione = t(revocato ? 'pair.blurb.revoked' : 'pair.blurb.new');
  // WHICH Topics is asking for the gesture. When the server does not say (one
  // older than this client) the line does not appear: an empty label under the
  // mark is worse than no label.
  const installazione = session.status === 'unpaired' ? session.installationName : null;

  // Chiede un codice e poi aspetta. Il polling è a 2s: il gesto umano dall'altra
  // parte dura secondi, non millisecondi, e una connessione persistente qui
  // sarebbe complessità per niente.
  useEffect(() => {
    let vivo = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function avvia() {
      // The error is NOT cleared here, and that is not an oversight.
      //
      // Clearing it made the screen FLASH on every retry: the notice vanished
      // as the attempt began and came back an instant later, and against a
      // machine that is off, where attempts follow each other for minutes, it
      // was a steady blink. Seen on the phone, and the reason for this line.
      // The error state is REPLACED when a new outcome arrives, so what is on
      // screen stays still while the retry happens.
      setDenied(false);
      try {
        const r = await fetch('/api/auth/pair/request', { method: 'POST', credentials: 'same-origin' });
        if (!r.ok) {
          // A reply exists: the server is reachable and states the reason.
          // Read the code and RETRY on our own. Almost every refusal on this
          // route is transient, and a screen that waits for a gesture to redo
          // something it can redo itself is a dead end dressed as a notice.
          const corpo = await r.json().catch(() => null) as { error?: string } | null;
          if (!vivo) return;
          setError(motivoDaRisposta(corpo));
          riprovaPiuTardi();
          return;
        }
        const body = await r.json() as { requestId: string; code: string; claim?: string };
        if (!vivo) return;
        // Success: the error goes now, because something replaces it on screen
        // (the code). It is the only moment where clearing leaves no hole.
        setError(null);
        tentativiRef.current = 0;
        requestIdRef.current = body.requestId;
        // Il segreto di ritiro: torna solo qui, e da qui non esce più. Senza,
        // chiunque avesse visto passare il `requestId` poteva incassare il
        // gettone al posto nostro.
        claimRef.current = body.claim ?? '';
        setCode(body.code);
        attendi();
      } catch {
        // No reply at all: here "is the computer on?" is the right question.
        if (!vivo) return;
        setError('unreachable');
        riprovaPiuTardi();
      }
    }

    /**
     * Retries on its own, with growing delay.
     *
     * Without this the screen stopped at the first error and stayed there: the
     * only way out was reloading the page, and whoever does not know that sits
     * in front of a notice forever. A machine coming back up, a server
     * finishing a restart, a tunnel losing signal are all cases where the right
     * wait is a few seconds, not a human gesture.
     *
     * The delay grows (2s, 4s, 8s, capped at 30) because retrying every two
     * seconds for an hour against a machine that is off is a phone getting warm
     * in a pocket.
     */
    function riprovaPiuTardi() {
      tentativiRef.current += 1;
      timer = setTimeout(() => { void avvia(); }, attesaRiprova(tentativiRef.current));
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
  }, [session.status, oraRiprova]);

  return (
    // Il piano si dichiara con la costante, non con un 9999 scritto a mano —
    // che per giunta è il piano dei POPOVER, non quello di una superficie che
    // deve coprire tutto. Oggi non si nota, perché `SessionRoot` monta questo
    // cancello INVECE dell'app e non c'è niente sotto con cui competere: ma è
    // proprio questo che rende il numero a mano insidioso, il giorno in cui
    // qualcosa (un toast, un overlay di sviluppo, un portal condiviso) si
    // monta accanto e vince un pareggio per ordine nel DOM.
    // ── WHY IT SCROLLS, AND WHY THE EDGE IS NOT THE SCREEN'S ────────────────
    //
    // `fixed inset-0` plus vertical centring is a trap on a phone: when the
    // content is taller than the window, whatever falls outside cannot be
    // reached at all, because a `fixed` element does not lengthen the
    // document. And the window shrinks on its own: the browser bars appear
    // OVER the content and eat dozens of points.
    //
    // Measured with WebKit at 320x420 (a small iPhone with the URL bar open):
    // the status line ended at 453px out of 420 visible, and `scrollHeight`
    // equalled `innerHeight`, so it was both invisible and unreachable.
    //
    // Three things close it, together:
    //  · `overflow-y-auto`: if it does not fit, it scrolls. This is the safety
    //    net that makes any mistake about height harmless.
    //  · `items-start` with `sm:items-center`: centring is right when space is
    //    left over, but on a short screen centring is what clips SYMMETRICALLY,
    //    hiding the heading at the top as well.
    //  · `min-h-dvh` on the content plus `py-10`: `dvh` is the DYNAMIC height,
    //    the one that accounts for the bars as they appear and go, while `vh`
    //    does not, which is why the bottom of a page ends up under the toolbar.
    //    The vertical padding keeps the first and last rows off the edges when
    //    scrolling.
    <div className={`fixed inset-0 ${MODAL_LAYER} overflow-y-auto overscroll-contain bg-app-bg`}>
      <div className="flex min-h-dvh items-start justify-center px-6 py-10 sm:items-center">
        <div className="w-full max-w-sm text-center">
          {/* WHO you are, before what you must do.

              This screen is the FIRST thing a person sees of Topics from the
              phone, and for months it was a heading in the middle of black:
              no mark, no version, no way to tell whether the thing was alive.
              An app that does not introduce itself looks like a fault. Same
              lesson as the heading that said "Device not authorised" to someone
              arriving for the first time. */}
          <img
            src="/icons/icon-192.png"
            alt=""
            width={52}
            height={52}
            className="mx-auto mb-4 rounded-[12px] border border-app-border"
          />
          <div className="mb-5 text-[11px] font-medium uppercase tracking-[0.08em] text-app-text-muted">
            Topics{VERSIONE ? ` · ${VERSIONE}` : ''}
          </div>

          <h1 className="text-[19px] font-semibold text-app-text">{titolo}</h1>
          {/* THE SUBJECT of the request, right under the heading.

              "Authorise this device" does not say to WHOM. With one
              installation nobody notices; with two it becomes an act of trust
              towards something unnamed. Here the name is there, and it is the
              one a person would use saying it out loud. */}
          {installazione && (
            <p className="mt-1 text-[13px] font-medium text-app-text">{installazione}</p>
          )}
          <p className="mt-2 text-[13px] leading-relaxed text-app-text-secondary">{spiegazione}</p>

          {error && !denied && (
            <div className="mt-6 rounded-lg border border-app-border bg-surface px-4 py-3">
              <p className="text-[13px] text-app-text-secondary">
                {t(chiaveFrase(error))}
              </p>
              {/* The retry is already running: saying so makes the wait a wait
                  instead of a block. The button is for whoever does not want to
                  wait for the next round, not the only way out. */}
              <p className="mt-1 text-[12px] text-app-text-muted">{t('pair.retrying')}</p>
              <button
                onClick={() => { tentativiRef.current = 0; setOraRiprova((n) => n + 1); }}
                className="mt-3 rounded-lg border border-app-border px-4 py-2 text-[13px] text-app-text hover:bg-surface"
              >
                {t('pair.retry')}
              </button>
            </div>
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

          {/* THE STATE, always, at the bottom. A dot telling whether the machine
              is answering separates "I am waiting" from "it is broken" without
              asking anyone to read: green while the loop works, amber while it
              retries. It is what the screen already knew and never showed. */}
          <div className="mt-10 flex items-center justify-center gap-2 text-[11px] text-app-text-muted">
            <span
              className={`h-1.5 w-1.5 rounded-full ${error ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'}`}
            />
            {t(chiaveStato(error))}
          </div>
        </div>
      </div>
    </div>
  );
}
