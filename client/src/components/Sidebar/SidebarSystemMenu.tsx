import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronRight, Gauge, Tag, User } from 'lucide-react';
import { usePersonaCorrente } from '@/hooks/usePersonaCorrente';
import { etichettaIdentita } from './identityLabel';
import { subscribeSession, type SessionState } from '@/lib/auth/session';
import { getVersion } from '@/lib/shell/app';
import { PerfSection } from './PerfSection';

declare const __APP_VERSION__: string;

/**
 * QUELLO CHE STAVA IN FONDO ALLA COLONNA, ORA DENTRO IL MENU «Topics».
 *
 * Sul telefono la barra di stato non c'è più: «è qualcosa che l'utente
 * raramente utilizzerà» (Attilio, 12/08), e occupava 80px di una colonna alta e
 * stretta — 36 di identità più 44 di stato — per dire, a riposo, «Questo
 * computer». Le stesse tre cose vivono qui, dove si va a cercarle:
 *
 *  · CHI SEI — la faccia, il nome, e la porta dell'account. È anche l'unica
 *    porta che esisteva: `AccountSection` si disegna solo dentro Impostazioni →
 *    Account, e da mobile lì non ci arrivava nessuno («non vedo ancora la parte
 *    di possibilità di fare login»).
 *  · COME VA — prestazioni e stato di sistema, che si aprono solo se le chiedi:
 *    il pannello pesante resta `lazy`, come nella barra.
 *  · CHE VERSIONE È — il numero, e il changelog dietro.
 *
 * La faccia arriva da `peopleApi.list()` (`isMe`), la stessa fonte della
 * rubrica: un secondo posto da cui prendere l'avatar sarebbe un secondo avatar
 * che un giorno mostra un'altra persona. Se il profilo GitHub non c'è, restano
 * le iniziali — mai un buco: una superficie che non dice chi sei è
 * indistinguibile da una che non sa che ci sei.
 *
 * Quel «secondo posto» ESISTEVA, ed era la riga in fondo alla sidebar sul
 * desktop: questa voce mostrava la persona, quella il nome del ferro. Adesso la
 * fetch è una sola (`usePersonaCorrente`) e la scelta di cosa scrivere è una
 * sola (`etichettaIdentita`), così le due superfici non possono più divergere.
 */

const importSystemStatusPanel = async () => {
  const { SystemStatusPanel: Component } = await import('./SystemStatusPanel');
  return { default: Component };
};
const SystemStatusPanel = lazy(importSystemStatusPanel);

const VOCE = 'w-full flex items-center gap-2.5 px-3 py-3 text-[14px] text-app-text hover:bg-app-hover transition-colors';

export interface SidebarSystemMenuProps {
  /** Apre Impostazioni → Account e dispositivi (dove vivono account, persone e
   *  dispositivi autorizzati). */
  onOpenAccount: () => void;
  /** Apre il changelog. La versione viaggia col gesto perché la modale la
   *  chiede e qui la si conosce già: farla ri-cercare a chi ospita la modale
   *  sarebbe un secondo modo di rispondere a «che versione gira», e i due
   *  divergono il giorno di un auto-update. */
  onOpenChangelog: (versione: string) => void;
}

export function SidebarSystemMenu({ onOpenAccount, onOpenChangelog }: SidebarSystemMenuProps) {
  const [sessione, setSessione] = useState<SessionState>({ status: 'loading' });
  const [mostraStato, setMostraStato] = useState(false);
  const [versione, setVersione] = useState<string>(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '');

  useEffect(() => subscribeSession(setSessione), []);

  // La rubrica la chiede il hook, che è anche quello della riga in fondo alla
  // colonna sul desktop: due fetch della stessa persona erano due avatar che un
  // giorno mostrano due persone diverse.
  const io = usePersonaCorrente();

  // Nell'app desktop la versione la sa la shell, e un auto-update può averla
  // cambiata dopo la build di questo bundle: si chiede, e si ripiega su quella
  // compilata solo se non risponde.
  useEffect(() => {
    let vivo = true;
    void getVersion().then((v) => { if (vivo && v) setVersione(v); }).catch(() => {});
    return () => { vivo = false; };
  }, []);

  const chi = etichettaIdentita(io, sessione);

  return (
    <div data-testid="sidebar-system-menu">
      <button type="button" onClick={onOpenAccount} className={VOCE} data-testid="menu-account">
        {chi.avatarUrl ? (
          <img src={chi.avatarUrl} alt="" className="h-9 w-9 flex-shrink-0 rounded-full object-cover" />
        ) : chi.iniziali ? (
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[13px] font-semibold text-white">
            {chi.iniziali}
          </div>
        ) : (
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-app-hover">
            <User size={16} className="text-app-text-tertiary" />
          </div>
        )}
        <span className="flex min-w-0 flex-1 flex-col text-left">
          {/* Senza nome NON si scrive un nome finto: si dice cosa c'è dietro la
              porta, che è la sola cosa vera che si sa. */}
          <span className="truncate font-medium">{chi.nome || 'Il tuo account'}</span>
          <span className="truncate text-[11px] text-app-text-secondary">
            {chi.dettaglio || 'Account e dispositivi'}
          </span>
        </span>
        <ChevronRight size={16} className="flex-shrink-0 text-app-text-tertiary" />
      </button>

      <button
        type="button"
        onClick={() => setMostraStato((v) => !v)}
        className={VOCE}
        aria-expanded={mostraStato}
        data-testid="menu-system-status"
      >
        <Gauge size={18} className="flex-shrink-0" />
        <span className="flex-1 text-left">Prestazioni e sistema</span>
        <ChevronRight size={16} className={`flex-shrink-0 text-app-text-tertiary transition-transform ${mostraStato ? 'rotate-90' : ''}`} />
      </button>
      {mostraStato && (
        <div className="border-y border-app-border">
          <PerfSection />
          <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
            <SystemStatusPanel enabled />
          </Suspense>
        </div>
      )}

      <button type="button" onClick={() => onOpenChangelog(versione)} className={VOCE} data-testid="menu-version">
        <Tag size={18} className="flex-shrink-0" />
        <span className="flex-1 text-left">Versione</span>
        <span className="flex-shrink-0 text-[12px] tabular-nums text-app-text-secondary">{versione || '-'}</span>
      </button>
    </div>
  );
}
