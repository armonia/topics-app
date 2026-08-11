/**
 * I token di colore (e la posizione) dei chip flottanti di una browser pane.
 *
 * Stanno QUI e non dentro `BrowserPaneChip.tsx` per una ragione meccanica: un
 * modulo che esporta un componente **e** qualcos'altro spegne il fast refresh
 * per tutto il file (`react-refresh/only-export-components`), cioè ogni salvataggio
 * sul chip ricarica la pagina invece del componente. La costante è esportata
 * perché un test possa asserire la DECISIONE sul colore senza un DOM in cui
 * renderizzare; il componente la importa e basta.
 *
 * I numeri dietro alle scelte — perché `green-600`/`yellow-600` non passano, e
 * perché il velo `/15` fa parte della misura — sono in `BrowserPaneChip.tsx` e
 * in `lib/popoverStyles`.
 */
import { DANGER_TEXT, WARNING_TEXT, SUCCESS_TEXT, ACTIVE_TEXT } from '../../lib/popoverStyles';

export type ChipTone = 'neutral' | 'active' | 'ok' | 'warn' | 'danger';

/** Where the chip sits inside the pane. `top-center` belongs to transient hints
 *  (they read as a message, not as a control), the corners to state + toggles. */
export type ChipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'top-center';

/** Exported so a test can assert the colour DECISION (the measured pairs) without
 *  needing a DOM to render into. */
export const TONE: Record<ChipTone, string> = {
  // The off state of a toggle: readable, but visibly not "on".
  neutral: 'bg-surface/90 border-app-border text-app-text-secondary hover:bg-surface hover:text-app-text',
  active: `bg-primary/15 border-primary/40 ${ACTIVE_TEXT} hover:bg-primary/25`,
  ok: `bg-green-500/15 border-green-500/30 ${SUCCESS_TEXT}`,
  warn: `bg-yellow-500/15 border-yellow-500/30 ${WARNING_TEXT}`,
  danger: `bg-red-500/15 border-red-500/30 ${DANGER_TEXT}`,
};

export const CORNER: Record<ChipCorner, string> = {
  'top-left': 'top-2 left-2',
  'top-right': 'top-2 right-2',
  'bottom-left': 'bottom-2 left-2',
  'top-center': 'top-2 left-1/2 -translate-x-1/2',
};
