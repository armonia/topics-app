/**
 * client/src/lib/i18n-project-hub-en.ts - the strings of the project row's hub
 * data (hub-smistamento, HUBBR-16) in English, the mirror of
 * `i18n-project-hub-it.ts`. Loaded with the row's own chunk.
 */
import type { Dict } from './i18n-types';

const PROJECT_HUB_EN: Dict = {
  'projectHub.week': '{pct}% of the week',
  'projectHub.weekTail': 'of the week',
  'projectHub.weekTailClaude': 'of the Claude week',
  'projectHub.weekBudget': '{pct}% of the Claude week out of a {cap}% budget',
  'projectHub.held': 'Held: {why}',
  'projectHub.heldBudget': 'Held by the budget',
  'projectHub.heldBare': 'Held',
  'projectHub.until': 'starts again at {time}',
  'projectHub.untilDay': 'starts again {day} at {time}',
  'projectHub.waitsFor': 'waiting for {who}',
  'projectHub.priorityIs.alta': 'High priority',
  'projectHub.priorityIs.bassa': 'Low priority',
  'projectHub.agents': '{n} agents at work',
  'projectHub.agentsOne': '1 agent at work',
  'projectHub.agentsMore': 'and {n} more',
  'projectHub.pace': '{n}/h',
  'projectHub.paceTitle': 'Tokens of the last hour of the agents at work',
  'projectHub.idle': 'No agent for {t}, the last on {day} ({who})',
  'projectHub.idleLong': 'No agent for over 7 days',
  'projectHub.dirMissing': 'The folder was temporary and is gone',
  'projectHub.span.min': '{n} min',
  'projectHub.span.h': '{n} h',
  'projectHub.span.d': '{n} d',
  'projectHub.agent.since': 'for {t}',
  'projectHub.agent.ago': '{t} ago',
  'projectHub.agent.now': 'now',
  'projectHub.agent.tokens': '{n} tokens',
  'projectHub.agent.pct': '{pct}% of week',
  'projectHub.agent.open': 'Open',
  'projectHub.agent.openVia': 'Opens in {via}',
  'projectHub.opus': '{n} Opus for {t} on a project at {pct}% of the Claude week: consider Sonnet',
  'projectHub.budgetHint': 'On the Claude week: past it, background jobs stop, chats do not',
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
