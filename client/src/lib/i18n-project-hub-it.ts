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
  'projectHub.queued': 'In coda: {why}',
  'projectHub.queuedBare': 'In coda',
  'projectHub.over': 'Oltre il budget della settimana',
  'projectHub.priority': 'Priorità',
  'projectHub.priority.alta': 'Alta',
  'projectHub.priority.normale': 'Normale',
  'projectHub.priority.bassa': 'Bassa',
  'projectHub.budget': 'Budget della settimana',
  'projectHub.budget.none': 'Nessuno',
  'projectHub.budget.pct': '{pct}%',
  'projectHub.failed': 'Non salvato: {why}',
};

export default PROJECT_HUB_IT;
