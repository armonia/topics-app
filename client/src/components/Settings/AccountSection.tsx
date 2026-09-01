import { useCallback } from 'react';
import { KeyRound, Mail, Unlink } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useConfirm } from '../../hooks/useConfirm';
import { useAccountLink } from '../../hooks/useAccountLink';
import { mostraSezione } from './accountState';

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
 *
 * ── LO STATO NON VIVE PIÙ QUI ───────────────────────────────────────────────
 * The link, the two steps and the refusal codes are `useAccountLink`, because
 * the identity dropdown in the sidebar now offers the same sign-in: two copies
 * of this flow would diverge at the first refusal code handled on one side
 * only. This file is the drawing, and the confirmation before unlinking, which
 * is the one thing only a surface with room for a modal can do.
 */
export function AccountSection() {
  const t = useT();
  const askConfirm = useConfirm();
  const {
    state, step, email, code, error, busy,
    setEmail, setCode, askCode, verify, back, unlink,
  } = useAccountLink();

  const signOut = useCallback(async () => {
    if (!await askConfirm({ title: t('account.unlink'), body: t('account.unlinkConfirm') })) return;
    await unlink();
  }, [askConfirm, t, unlink]);

  if (!mostraSezione(state) || !state) return null;

  const campo = 'flex-1 min-w-0 rounded border border-app-border bg-app-bg px-2 py-1 text-[12px] text-app-text outline-none focus:border-app-accent';
  const bottone = 'flex-shrink-0 rounded border border-app-border px-2 py-1 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50';

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-app-text-secondary">
        {t('account.title')}
      </h3>
      <p className="text-[11px] leading-relaxed text-app-text-tertiary">{t('account.blurb')}</p>

      <div className="space-y-2 rounded-lg border border-app-border px-3 py-2.5">
        {state.linked ? (
          <>
            <div className="flex items-center gap-2">
              <Mail size={12} className="flex-shrink-0 text-app-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-app-text">
                {t('account.linkedAs', { email: state.email ?? '' })}
              </span>
              <button
                disabled={busy}
                onClick={() => void signOut()}
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
            {state.personName && (
              <p className="text-[11px] text-app-text-tertiary">
                {t('account.linkedTo', { nome: state.personName })}
              </p>
            )}
            {/* Il collegamento vale anche col servizio spento: lo si DICE, invece
                di lasciar credere che qualcosa qui si sia rotto. */}
            {!state.configured && (
              <p className="text-[11px] text-app-text-tertiary">{t('account.offline')}</p>
            )}
          </>
        ) : step.phase === 'address' ? (
          <div className="space-y-1.5">
            <div className="text-[11px] text-app-text-tertiary">{t('account.notLinked')}</div>
            <div className="flex gap-1.5">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void askCode(); }}
                aria-label={t('account.emailLabel')}
                placeholder={t('account.emailPlaceholder')}
                className={campo}
              />
              <button disabled={busy || !email.trim()} onClick={() => void askCode()} className={bottone}>
                {t('account.sendCode')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[11px] text-app-text-tertiary">
              {t('account.codeSent', { email: step.email })}
            </p>
            <div className="flex gap-1.5">
              <input
                autoFocus
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void verify(); }}
                aria-label={t('account.codeLabel')}
                placeholder={t('account.codePlaceholder')}
                className={campo}
              />
              <button disabled={busy || !code.trim()} onClick={() => void verify()} className={bottone}>
                <span className="flex items-center gap-1">
                  <KeyRound size={11} />
                  {t('account.confirm')}
                </span>
              </button>
              <button
                onClick={back}
                className="flex-shrink-0 rounded px-2 py-1 text-[11px] text-app-text-tertiary hover:bg-app-hover"
              >
                {t('account.cancel')}
              </button>
            </div>
          </div>
        )}

        {error && <p className="text-[11px] text-red-500">{t(error)}</p>}
      </div>

      <p className="text-[11px] leading-relaxed text-app-text-tertiary">{t('account.footnote')}</p>
    </div>
  );
}
