import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronRight, Gauge, Tag } from 'lucide-react';
import { getVersion } from '@/lib/shell/app';
import { PerfSection } from './PerfSection';

declare const __APP_VERSION__: string;

/**
 * QUELLO CHE STAVA IN FONDO ALLA COLONNA, ORA DENTRO IL MENU «Topics».
 *
 * Sul telefono la barra di stato non c'è più: «è qualcosa che l'utente
 * raramente utilizzerà» (Attilio, 12/08), e occupava 80px di una colonna alta e
 * stretta — 36 di identità più 44 di stato — per dire, a riposo, «Questo
 * computer». Restano qui due cose, ed è dove si va a cercarle:
 *
 *  · COME VA — prestazioni e stato di sistema, che si aprono solo se le chiedi:
 *    il pannello pesante resta `lazy`, come nella barra.
 *  · CHE VERSIONE È — il numero, e il changelog dietro.
 *
 * ── CHI SEI NON STA PIÙ QUI ────────────────────────────────────────────────
 * L'account ci è passato per due giorni, in testa al menu. Era comunque dietro
 * un gesto — apri il menu, poi scegli — e il profilo non è una voce di menu, è
 * una faccia: adesso è la quarta porta della fila in fondo allo schermo
 * (`MobileChromeBar`), a portata di pollice (Attilio, 14/08). Qui NON resta un
 * duplicato: due porte per la stessa stanza sono due posti che un giorno
 * dicono cose diverse.
 */

const importSystemStatusPanel = async () => {
  const { SystemStatusPanel: Component } = await import('./SystemStatusPanel');
  return { default: Component };
};
const SystemStatusPanel = lazy(importSystemStatusPanel);

const VOCE = 'w-full flex items-center gap-2.5 px-3 py-3 text-[14px] text-app-text hover:bg-app-hover transition-colors';

export interface SidebarSystemMenuProps {
  /** Apre il changelog. La versione viaggia col gesto perché la modale la
   *  chiede e qui la si conosce già: farla ri-cercare a chi ospita la modale
   *  sarebbe un secondo modo di rispondere a «che versione gira», e i due
   *  divergono il giorno di un auto-update. */
  onOpenChangelog: (versione: string) => void;
}

export function SidebarSystemMenu({ onOpenChangelog }: SidebarSystemMenuProps) {
  const [mostraStato, setMostraStato] = useState(false);
  const [versione, setVersione] = useState<string>(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '');

  // Nell'app desktop la versione la sa la shell, e un auto-update può averla
  // cambiata dopo la build di questo bundle: si chiede, e si ripiega su quella
  // compilata solo se non risponde.
  useEffect(() => {
    let vivo = true;
    void getVersion().then((v) => { if (vivo && v) setVersione(v); }).catch(() => {});
    return () => { vivo = false; };
  }, []);

  return (
    <div data-testid="sidebar-system-menu">
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
