import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, CreditCard, Trash2 } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useConfirm } from '../../hooks/useConfirm';
import { openExternalOnce } from '../../lib/openExternal';
import {
  chiaveErroreCheckout, chiaveMotivo, colpaNostra, giorniAllaScadenza,
  mostraMotivo, POSTI_MAX_ACQUISTO, POSTI_MIN_ACQUISTO, postiValidi, scadenzaVicina,
  siPuoComprare, type StatoPagamento, type StatoPiano,
} from './pianoState';

/**
 * IL PIANO: cosa questa installazione può fare, e come si cambia.
 *
 * ── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Il server sapeva già rispondere a tutto — `/api/license` per cosa è concesso,
 * `/api/billing` per il pagamento — e nell'interfaccia non c'era una riga che
 * lo chiedesse. Il risultato: una persona che voleva pagare non aveva un
 * bottone da premere, e una che aveva un problema di licenza non aveva nessun
 * posto in cui vederlo. Il prodotto era vendibile ovunque tranne che nello
 * schermo.
 *
 * ── IL GRATUITO NON È UNA MANCANZA ──────────────────────────────────────────
 * Questa sezione si apre dicendo cosa hai, non cosa ti manca. Il confine del
 * listino è quello di ORG-08 — tutto il locale e tutta la rete di casa sono
 * gratis, per sempre e senza account; si paga l'essere raggiunti da un'ALTRA
 * rete — quindi su quasi tutte le installazioni qui non c'è niente di rotto da
 * segnalare, e la sezione deve leggersi come una constatazione.
 *
 * ── SI DICE SEMPRE PERCHÉ ───────────────────────────────────────────────────
 * I sette motivi che `licenza.ts` distingue arrivano fin qui separati
 * (`pianoState.ts`). Il caso che conta più di tutti è `no_verification_key`:
 * vuol dire che questa build non ha con cosa controllare NESSUNA licenza, e
 * senza dirlo la persona resta a incollare gettoni che non potranno mai
 * funzionare, convinta di sbagliare lei.
 *
 * ── E NON SI FINGE DI POTER VENDERE ─────────────────────────────────────────
 * Senza Stripe configurato il bottone d'acquisto non si disegna affatto. Un
 * bottone che apre un checkout e torna `not_configured` è peggio di nessun
 * bottone: il rifiuto arriva dopo il clic, e sembra un guasto.
 */
export function PlanSection() {
  const t = useT();
  const conferma = useConfirm();
  const [piano, setPiano] = useState<StatoPiano | null>(null);
  const [pagamento, setPagamento] = useState<StatoPagamento | null>(null);
  const [posti, setPosti] = useState(POSTI_MIN_ACQUISTO);
  const [gettone, setGettone] = useState('');
  const [errore, setErrore] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);
  const [copiato, setCopiato] = useState(false);

  const carica = useCallback(async () => {
    try {
      const [l, b] = await Promise.all([
        fetch('/api/license', { credentials: 'same-origin' }).then((r) => r.json()),
        fetch('/api/billing', { credentials: 'same-origin' }).then((r) => r.json()),
      ]) as [StatoPiano, StatoPagamento];
      setPiano(l);
      setPagamento(b);
    } catch {
      // Le due rotte sono locali e rispondono sempre `200` per costruzione: se
      // non rispondono è il server a essere giù, e allora non si inventa uno
      // stato — la sezione resta vuota invece di dichiarare un piano che non
      // abbiamo letto.
      setPiano(null);
    }
  }, []);

  useEffect(() => { void carica(); }, [carica]);

  const compra = useCallback(async () => {
    setInCorso(true);
    setErrore(null);
    try {
      const r = await fetch('/api/billing/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seats: postiValidi(posti) }),
      });
      const b = await r.json().catch(() => null) as { ok?: boolean; url?: string; code?: string } | null;
      if (!r.ok || !b?.ok || !b.url) { setErrore(chiaveErroreCheckout(b?.code)); return; }
      // FUORI, sempre: il pagamento avviene sul dominio di Stripe, e dentro una
      // pane dell'app sarebbe una schermata di pagamento senza barra degli
      // indirizzi — cioè senza il solo modo che una persona ha di sapere a chi
      // sta dando la carta.
      openExternalOnce(b.url);
    } catch {
      setErrore(chiaveErroreCheckout('unreachable'));
    } finally {
      setInCorso(false);
    }
  }, [posti]);

  const installa = useCallback(async () => {
    const g = gettone.trim();
    if (!g) return;
    setInCorso(true);
    setErrore(null);
    try {
      const r = await fetch('/api/license', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: g }),
      });
      const b = await r.json().catch(() => null) as (StatoPiano & { error?: string }) | null;
      if (!r.ok || b?.error) {
        // Il rifiuto porta il MOTIVO, e il motivo è la cosa utile: «rifiutato»
        // e basta è ciò che trasforma un problema di distribuzione in un
        // sospetto di truffa.
        setErrore(b?.reason ? chiaveMotivo(b.reason) : 'plan.checkoutErr.generic');
        return;
      }
      setGettone('');
      await carica();
    } catch {
      setErrore('plan.checkoutErr.unreachable');
    } finally {
      setInCorso(false);
    }
  }, [gettone, carica]);

  const rimuovi = useCallback(async () => {
    if (!await conferma({ title: t('plan.remove'), body: t('plan.removeConfirm') })) return;
    setInCorso(true);
    try {
      await fetch('/api/license', { method: 'DELETE', credentials: 'same-origin' });
      await carica();
    } finally {
      setInCorso(false);
    }
  }, [conferma, t, carica]);

  if (!piano) return null;

  const campo = 'flex-1 min-w-0 rounded border border-app-border bg-app-bg px-2 py-1 text-[12px] text-app-text outline-none focus:border-app-accent coarse:min-h-11';
  const bottone = 'flex-shrink-0 rounded border border-app-border px-2 py-1 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50 coarse:min-h-11 coarse:min-w-11';

  const giorni = giorniAllaScadenza(piano.expiresAt, Date.now());
  const warnExpiry = scadenzaVicina(piano.expiresAt, Date.now());

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-app-text-secondary">
        {t('plan.title')}
      </h3>
      <p className="text-[11px] leading-relaxed text-app-text-tertiary">{t('plan.blurb')}</p>

      <div className="space-y-2.5 rounded-lg border border-app-border px-3 py-2.5">
        {/* ── COSA HAI. Prima riga, sempre, anche sul gratuito. */}
        <div className="flex items-center gap-2">
          <CreditCard size={12} className="flex-shrink-0 text-app-text-tertiary" />
          <span className="min-w-0 flex-1 text-[12px] text-app-text">
            {t(piano.plan === 'team' ? 'plan.current.team' : 'plan.current.free', {
              posti: String(piano.seats),
            })}
          </span>
        </div>

        <p className="text-[11px] leading-relaxed text-app-text-tertiary">
          {t(piano.remoteAccess ? 'plan.remote.on' : 'plan.remote.off')}
        </p>

        {/* La scadenza si nomina solo quando è vicina: un conto alla rovescia
            che parte da un anno è rumore, e il rumore addestra a non leggere. */}
        {warnExpiry && giorni !== null && (
          <p className="text-[11px] leading-relaxed text-app-text">
            {t(giorni < 0 ? 'plan.expiredSince' : 'plan.expiresIn', { giorni: String(Math.abs(giorni)) })}
          </p>
        )}

        {/* ── PERCHÉ, quando c'è un perché da dire. */}
        {mostraMotivo(piano.reason) && (
          <p className={`rounded border px-2 py-1.5 text-[11px] leading-relaxed ${
            colpaNostra(piano.reason)
              ? 'border-app-border bg-app-bg text-app-text'
              : 'border-app-border text-app-text-secondary'
          }`}>
            {t(chiaveMotivo(piano.reason))}
          </p>
        )}

        {/* ── COMPRARE, solo se si può davvero. */}
        {siPuoComprare(pagamento) && piano.plan !== 'team' && (
          <div className="flex items-center gap-1.5 border-t border-app-border pt-2.5">
            <label htmlFor="plan-seats" className="text-[11px] text-app-text-tertiary">
              {t('plan.seatsLabel')}
            </label>
            <input
              id="plan-seats"
              type="number"
              min={POSTI_MIN_ACQUISTO}
              max={POSTI_MAX_ACQUISTO}
              value={posti}
              onChange={(e) => setPosti(Number(e.target.value))}
              onBlur={() => setPosti(postiValidi(posti))}
              className="w-16 rounded border border-app-border bg-app-bg px-2 py-1 text-[12px] text-app-text outline-none focus:border-app-accent coarse:min-h-11"
            />
            <button disabled={inCorso} onClick={() => void compra()} className={`${bottone} ml-auto`}>
              {t('plan.subscribe')}
            </button>
          </div>
        )}

        {/* ── INCOLLARE UN GETTONE. Resta sempre: è la strada di chi ha pagato
            fuori da qui, ed è anche l'unica su un'installazione senza Stripe. */}
        <div className="space-y-1.5 border-t border-app-border pt-2.5">
          <div className="text-[11px] text-app-text-tertiary">{t('plan.tokenHint')}</div>
          <div className="flex gap-1.5">
            <input
              value={gettone}
              onChange={(e) => setGettone(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void installa(); }}
              aria-label={t('plan.tokenLabel')}
              placeholder={t('plan.tokenPlaceholder')}
              className={campo}
            />
            <button disabled={inCorso || !gettone.trim()} onClick={() => void installa()} className={bottone}>
              {t('plan.install')}
            </button>
          </div>
        </div>

        {errore && <p className="text-[11px] leading-relaxed text-app-text">{t(errore)}</p>}

        {/* ── L'IDENTIFICATIVO. Serve a chi conia il gettone, e senza un modo di
            copiarlo la persona lo trascrive a mano da uno schermo. */}
        {piano.installationId && (
          <div className="flex items-center gap-2 border-t border-app-border pt-2.5">
            <span className="text-[11px] text-app-text-tertiary">{t('plan.installationId')}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-app-text-secondary">
              {piano.installationId}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(piano.installationId);
                setCopiato(true);
                setTimeout(() => setCopiato(false), 1500);
              }}
              title={t('plan.copyId')}
              aria-label={t('plan.copyId')}
              className={bottone}
            >
              {copiato ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
        )}

        {/* ── TOGLIERE. Esiste perché una licenza che non si può togliere è una
            licenza che non si può spostare su un'altra macchina. */}
        {piano.plan === 'team' && (
          <div className="border-t border-app-border pt-2.5">
            <button disabled={inCorso} onClick={() => void rimuovi()} className={bottone}>
              <span className="flex items-center gap-1">
                <Trash2 size={11} />
                {t('plan.remove')}
              </span>
            </button>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-app-text-tertiary">{t('plan.footnote')}</p>
    </div>
  );
}
