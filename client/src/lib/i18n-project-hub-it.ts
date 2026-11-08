/**
 * client/src/lib/i18n-project-hub-it.ts - the strings of the project row's hub
 * data (hub-smistamento, HUBBR-16): the share of the week, the brake, the line
 * and the menu's priority and budget; in Italian, the mirror of
 * `i18n-project-hub-en.ts`.
 *
 * Loaded with the row's own chunk (`addCatalogue` in `i18n.ts`), not with the
 * entry: only a window with the hub reads these. A leaf: it takes its type
 * from `i18n-types.ts`.
 */
import type { Dict } from './i18n-types';

const PROJECT_HUB_IT: Dict = {
  'projectHub.week': '{pct}% della settimana',
  'projectHub.weekTail': 'della settimana',
  'projectHub.weekTailClaude': 'della settimana Claude',
  'projectHub.weekBudget': '{pct}% della settimana Claude su {cap}% di budget',
  'projectHub.held': 'Fermo: {why}',
  'projectHub.heldBudget': 'Fermo per il budget',
  'projectHub.heldBare': 'Fermo',
  'projectHub.until': 'riparte alle {time}',
  'projectHub.untilDay': 'riparte {day} alle {time}',
  'projectHub.waitsFor': 'aspetta {who}',
  'projectHub.priorityIs.alta': 'Priorità alta',
  'projectHub.priorityIs.bassa': 'Priorità bassa',
  'projectHub.agents': '{n} agenti al lavoro',
  'projectHub.agentsOne': '1 agente al lavoro',
  'projectHub.agentsMore': 'e altri {n}',
  'projectHub.pace': '{n}/h',
  'projectHub.paceTitle': 'Token dell\'ultima ora degli agenti al lavoro',
  'projectHub.idle': 'Nessun agente da {t}, l\'ultimo il {day} ({who})',
  'projectHub.idleLong': 'Nessun agente da oltre 7 giorni',
  'projectHub.dirMissing': 'La cartella era temporanea e non esiste più',
  'projectHub.span.min': '{n} min',
  'projectHub.span.h': '{n} h',
  'projectHub.span.d': '{n} g',
  'projectHub.agent.since': 'da {t}',
  'projectHub.agent.ago': '{t} fa',
  'projectHub.agent.now': 'adesso',
  'projectHub.agent.tokens': '{n} token',
  'projectHub.agent.pct': '{pct}% sett.',
  'projectHub.agent.open': 'Apri',
  'projectHub.agent.openVia': 'Si apre in {via}',
  'projectHub.opus': '{n} Opus da {t} su un progetto al {pct}% della settimana Claude: valuta Sonnet',
  'projectHub.budgetHint': 'In % della settimana Claude: oltre, si fermano i lavori in background, non le chat',
  'projectHub.queued': 'In coda: {why}',
  'projectHub.queuedBare': 'In coda',
  'projectHub.over': 'Oltre il budget della settimana',
  'projectHub.priority': 'Priorità',
  'projectHub.priority.alta': 'Alta',
  'projectHub.priority.normale': 'Normale',
  'projectHub.priority.bassa': 'Bassa',
  'projectHub.budget': 'Budget della settimana',
  'projectHub.budget.none': 'Nessuno',
  'projectHub.failed': 'Non salvato: {why}',
};

export default PROJECT_HUB_IT;
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
