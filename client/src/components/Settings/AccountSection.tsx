import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Mail, Unlink } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useConfirm } from '../../hooks/useConfirm';
import { mostraSezione, chiaveErrore, type StatoAccount } from './accountState';

/**
 * L'ACCOUNT: agganciare un'identità remota alla persona che è già qui.
 *
 * ── PERCHÉ È UNA SEZIONE A PARTE, SOPRA LE PERSONE ──────────────────────────
 * «Chi sono io per il mondo» e «chi conosco su questa macchina» sono due
 * domande diverse: la prima ha un'autorità fuori di qui, la seconda no. Metterle
 * nello stesso riquadro farebbe sembrare l'elenco delle persone una cosa che il
 * servizio possiede — che è esattamente il fraintendimento che ORG-02 esiste per
 * evitare.
 *
 * ── SPESSO NON SI VEDE, E VA BENE COSÌ ──────────────────────────────────────
 * Senza un servizio degli account configurato e senza collegamenti, la sezione
 * NON si disegna (`mostraSezione`): il piano gratuito non è una versione
 * mutilata di cui scusarsi in un pannello, è il prodotto. Appena c'è un
 * collegamento la sezione resta, anche se il servizio nel frattempo è sparito:
 * staccarsi è un gesto locale e deve restare raggiungibile senza rete.
 *
 * ── DUE PASSI, E IL SECONDO NON PERDE IL PRIMO ──────────────────────────────
 * Si chiede un codice, si incolla il codice. Il campo dell'indirizzo resta
 * visibile nel secondo passo: chi ha sbagliato una lettera deve poter tornare
 * indietro senza ricominciare, e «Annulla» riporta al primo passo invece di
 * chiudere tutto.
 *
 * ── NESSUN FALLIMENTO MUTO ──────────────────────────────────────────────────
 * Ogni rifiuto del server porta un codice, e a ogni codice corrisponde una
 * frase (`chiaveErrore`). Un codice più nuovo dell'interfaccia cade su quella
 * generica: un clic che non produce niente è indistinguibile, per chi guarda,
 * da un bottone rotto.
 */
type Passo = { fase: 'indirizzo' } | { fase: 'codice'; email: string };

export function AccountSection() {
  const t = useT();
  const conferma = useConfirm();
  const [stato, setStato] = useState<StatoAccount | null>(null);
  const [passo, setPasso] = useState<Passo>({ fase: 'indirizzo' });
  const [email, setEmail] = useState('');
  const [codice, setCodice] = useState('');
  const [errore, setErrore] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);

  const carica = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/account', { credentials: 'same-origin' });
      setStato(r.ok ? (await r.json()) as StatoAccount : null);
    } catch {
      // La rotta è locale: se non risponde è il server a essere giù, e la
      // sezione sparisce invece di mostrare uno stato inventato.
      setStato(null);
    }
  }, []);

  useEffect(() => { void carica(); }, [carica]);

  /** Un solo posto in cui una risposta diventa «è andata» o «ecco perché no». */
  const invia = useCallback(async (percorso: string, method: string, corpo?: unknown) => {
    setInCorso(true);
    setErrore(null);
    try {
      const r = await fetch(percorso, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
      });
      const b = await r.json().catch(() => null) as { ok?: boolean; code?: string } | null;
      if (!r.ok || b?.ok === false) {
        setErrore(chiaveErrore(b?.code));
        return false;
      }
      return true;
    } catch {
      setErrore(chiaveErrore('service_unreachable'));
      return false;
    } finally {
      setInCorso(false);
    }
  }, []);

  const chiediCodice = useCallback(async () => {
    const indirizzo = email.trim();
    if (!indirizzo) return;
    if (await invia('/api/auth/account/code', 'POST', { email: indirizzo })) {
      setPasso({ fase: 'codice', email: indirizzo });
      setCodice('');
    }
  }, [email, invia]);

  const confirmation_ = useCallback(async () => {
    if (passo.fase !== 'codice' || !codice.trim()) return;
    if (await invia('/api/auth/account/verify', 'POST', { email: passo.email, code: codice.trim() })) {
      setPasso({ fase: 'indirizzo' });
      setCodice('');
      await carica();
    }
  }, [passo, codice, invia, carica]);

  const scollega = useCallback(async () => {
    if (!await conferma({ title: t('account.unlink'), body: t('account.unlinkConfirm') })) return;
    if (await invia('/api/auth/account', 'DELETE')) await carica();
  }, [conferma, t, invia, carica]);

  if (!mostraSezione(stato) || !stato) return null;

  const campo = 'flex-1 min-w-0 rounded border border-app-border bg-app-bg px-2 py-1 text-[12px] text-app-text outline-none focus:border-app-accent';
  const bottone = 'flex-shrink-0 rounded border border-app-border px-2 py-1 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50';

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-app-text-secondary">
        {t('account.title')}
      </h3>
      <p className="text-[11px] leading-relaxed text-app-text-tertiary">{t('account.blurb')}</p>

      <div className="space-y-2 rounded-lg border border-app-border px-3 py-2.5">
        {stato.linked ? (
          <>
            <div className="flex items-center gap-2">
              <Mail size={12} className="flex-shrink-0 text-app-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-app-text">
                {t('account.linkedAs', { email: stato.email ?? '' })}
              </span>
              <button
                disabled={inCorso}
                onClick={() => void scollega()}
                title={t('account.unlink')}
                aria-label={t('account.unlink')}
                className={bottone}
              >
                <span className="flex items-center gap-1">
                  <Unlink size={11} />
                  {t('account.unlink')}
                </span>
              </button>
            </div>
            {stato.personName && (
              <p className="text-[11px] text-app-text-tertiary">
                {t('account.linkedTo', { nome: stato.personName })}
              </p>
            )}
            {/* Il collegamento vale anche col servizio spento: lo si DICE, invece
                di lasciar credere che qualcosa qui si sia rotto. */}
            {!stato.configured && (
              <p className="text-[11px] text-app-text-tertiary">{t('account.offline')}</p>
            )}
          </>
        ) : passo.fase === 'indirizzo' ? (
          <div className="space-y-1.5">
            <div className="text-[11px] text-app-text-tertiary">{t('account.notLinked')}</div>
            <div className="flex gap-1.5">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void chiediCodice(); }}
                aria-label={t('account.emailLabel')}
                placeholder={t('account.emailPlaceholder')}
                className={campo}
              />
              <button disabled={inCorso || !email.trim()} onClick={() => void chiediCodice()} className={bottone}>
                {t('account.sendCode')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[11px] text-app-text-tertiary">
              {t('account.codeSent', { email: passo.email })}
            </p>
            <div className="flex gap-1.5">
              <input
                autoFocus
                inputMode="numeric"
                value={codice}
                onChange={(e) => setCodice(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void confirmation_(); }}
                aria-label={t('account.codeLabel')}
                placeholder={t('account.codePlaceholder')}
                className={campo}
              />
              <button disabled={inCorso || !codice.trim()} onClick={() => void confirmation_()} className={bottone}>
                <span className="flex items-center gap-1">
                  <KeyRound size={11} />
                  {t('account.confirm')}
                </span>
              </button>
              <button
                onClick={() => { setPasso({ fase: 'indirizzo' }); setErrore(null); }}
                className="flex-shrink-0 rounded px-2 py-1 text-[11px] text-app-text-tertiary hover:bg-app-hover"
              >
                {t('account.cancel')}
              </button>
            </div>
          </div>
        )}

        {errore && <p className="text-[11px] text-red-500">{t(errore)}</p>}
      </div>

      <p className="text-[11px] leading-relaxed text-app-text-tertiary">{t('account.footnote')}</p>
    </div>
  );
}
