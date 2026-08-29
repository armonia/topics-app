/**
 * client/src/lib/i18n-spend-it.ts - the MONEY strings, in Italian.
 *
 * WHAT IS IN HERE: everything the agent-spend surface says. The chip in the
 * board header, the spend panel with its two caps in the board settings, and the
 * agent row of the cost probe. One surface in the interface, so one file.
 *
 * WHY A FRAGMENT AND NOT A BLOCK IN `i18n-it.ts`: both catalogues are near their
 * `check:bloat` ceiling, and the English one had five lines of room left. A
 * feature that needs seventeen keys cannot be a block inside a file that can
 * take five lines, and raising the ceiling would have bought nothing: the
 * catalogues really are the place every branch has to meet. The pair spreads
 * into the two catalogues, so `t()`, `chiaviDelCatalogo()` and `missingKeys()`
 * see exactly what they saw before.
 */
import type { Dict } from './i18n-types';

const SPEND_IT: Dict = {
  'board.spend.title': 'Spesa degli agenti',
  'board.spend.window': '{amount} nelle ultime 24h',
  'board.spend.total': '{amount} in tutto',
  'board.spend.unpriced': '{tokens} token non prezzabili (modello senza listino): non sono in questa cifra.',
  'board.spend.capTask': 'Tetto per card (USD)',
  'board.spend.capDay': 'Tetto per macchina, 24h (USD)',
  'board.spend.capNone': 'nessuno',
  'board.spend.overDay': 'Tetto giornaliero superato ({spent} su {cap}): il turno successivo non parte.',
  'board.spend.leftDay': 'Restano {amount} prima del tetto giornaliero.',
  'board.spend.capTaskNote': 'Una card che arriva a {cap} non fa partire il turno successivo, e lo scrive nel suo thread.',
  'board.spend.noCaps': 'Nessun tetto: nessun freno, nessun avviso. Il numero sopra si vede comunque.',

  'cost.agent': 'Agente della board',
  'cost.agentUnpriced': '(+{tokens} non prezzabili)',
};

export default SPEND_IT;
