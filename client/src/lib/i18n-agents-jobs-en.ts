/**
 * client/src/lib/i18n-agents-jobs-en.ts - the strings of «Agenti e lavori»
 * (hub-smistamento, HUBBR-13) in English, the mirror of
 * `i18n-agents-jobs-it.ts`.
 *
 * Loaded with the level's own chunk (`addCatalogue` in `i18n.ts`). A leaf: it
 * takes its type from `i18n-types.ts` and imports nothing else.
 */
import type { Dict } from './i18n-types';

const AGENTS_JOBS_EN: Dict = {
  'agentsJobs.updated': 'updated now',
  'agentsJobs.reading': 'reading',
  'agentsJobs.hubDown': 'Hub not reachable: Topics only',
  'agentsJobs.retry': 'Retry',
  'agentsJobs.filter.running': 'Running',
  'agentsJobs.filter.waiting': 'Waiting',
  'agentsJobs.filter.finished': 'Finished',
  'agentsJobs.band': '{n} waiting for you',
  'agentsJobs.bandOne': '1 waiting for you',
  'agentsJobs.section.topics': 'Topics sessions',
  'agentsJobs.section.topics.hint': 'in here',
  'agentsJobs.section.proxy': 'Proxy sessions',
  'agentsJobs.section.proxy.hint': 'outside Topics',
  'agentsJobs.section.queue': 'Hub queue',
  'agentsJobs.section.queue.hint': 'delegated jobs',
  'agentsJobs.section.workflows': 'Workflows',
  'agentsJobs.section.decide': 'Your call',
  'agentsJobs.section.decide.hint': 'waiting for you',
  'agentsJobs.section.line': 'In line',
  'agentsJobs.section.line.hint': 'they start on their own',
  'agentsJobs.section.quota': 'Held by a quota',
  'agentsJobs.section.quota.hint': 'they restart on their own',
  'agentsJobs.section.failed': 'Failed',
  'agentsJobs.section.failed.hint': 'to look at',
  'agentsJobs.section.today': 'Today',
  'agentsJobs.section.yesterday': 'Yesterday',
  'agentsJobs.empty.running': 'No agent is working right now',
  'agentsJobs.empty.waiting': 'Nothing waits for you and nothing is in line',
  'agentsJobs.empty.finished': 'Nothing finished today or yesterday',
  'agentsJobs.more': '{n} more',
  'agentsJobs.src.topic': 'Topics session',
  'agentsJobs.src.terminal': 'Terminal',
  'agentsJobs.src.proxy': 'Proxy',
  'agentsJobs.src.queue': 'Hub queue',
  'agentsJobs.src.workflow': 'Workflow',
  'agentsJobs.fallback.job': 'Delegated job',
  'agentsJobs.fallback.jobOn': 'Delegated job on {project}',
  'agentsJobs.fallback.proxy': 'Claude session outside Topics',
  'agentsJobs.meta.waitsYou': 'waiting for you',
  'agentsJobs.meta.finishedTurn': 'turn ended, to look at',
  'agentsJobs.meta.noExecutor': 'waiting for an executor',
  'agentsJobs.meta.restarts': 'restarts on its own',
  'agentsJobs.meta.exit': 'exited with code {n}',
  'agentsJobs.meta.requests': '{n} requests',
  'agentsJobs.meta.requestsOne': '1 request',
  'agentsJobs.meta.tokens': '{n} tok',
  'agentsJobs.chip.quota': 'quota',
  'agentsJobs.chip.failed': 'failed',
  'agentsJobs.openChat': 'Open the chat',
  'agentsJobs.openTerminal': 'Open the terminal',
  'agentsJobs.withdraw': 'Take out of the line',
  'agentsJobs.withdrawFailed': 'Not taken out: the hub did not answer',
  'agentsJobs.rank': '#{n}',
  'agentsJobs.min': '{n} min',
  'agentsJobs.hours': '{h} h {m}',
  'agentsJobs.footer': 'The night\'s cards stay on the',
  'agentsJobs.footer.board': 'Board',
};

export default AGENTS_JOBS_EN;
