/**
 * client/src/lib/i18n-project-hub-en.ts - the strings of the project row's hub
 * data (hub-smistamento, HUBBR-16) in English, the mirror of
 * `i18n-project-hub-it.ts`. Loaded with the row's own chunk.
 */
import type { Dict } from './i18n-types';

const PROJECT_HUB_EN: Dict = {
  'projectHub.week': '{pct}% of the week',
  'projectHub.weekBudget': '{pct}% of the week out of a {cap}% budget',
  'projectHub.held': 'Held: {why}',
  'projectHub.heldBare': 'Held',
  'projectHub.until': 'starts again at {time}',
  'projectHub.queued': 'In line: {why}',
  'projectHub.queuedBare': 'In line',
  'projectHub.over': 'Over the budget of the week',
  'projectHub.priority': 'Priority',
  'projectHub.priority.alta': 'High',
  'projectHub.priority.normale': 'Normal',
  'projectHub.priority.bassa': 'Low',
  'projectHub.budget': 'Budget of the week',
  'projectHub.budget.none': 'None',
  'projectHub.budget.pct': '{pct}%',
  'projectHub.failed': 'Not saved: {why}',
};

export default PROJECT_HUB_EN;
