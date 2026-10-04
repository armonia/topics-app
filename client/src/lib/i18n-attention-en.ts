/**
 * client/src/lib/i18n-attention-en.ts - the strings of the attention state
 * (change notifications-redesign): the «To look at» inbox, the sections of
 * the state view, the tier a tab names; in English, the mirror of
 * `i18n-attention-it.ts`.
 *
 * A leaf like `i18n-find-en.ts`: it takes its type from `i18n-types.ts` and
 * imports nothing else, so it travels with its catalogue.
 */
import type { Dict } from './i18n-types';

const ATTENTION_EN: Dict = {
  'attention.state.needsYou': 'waiting for you',
  'attention.state.error': 'finished with an error',
  'attention.state.done': 'finished',
  'attention.project.lookAt': '{n} to look at',
  'attention.project.more': '+{n} more',
  'attention.board.waiting': 'Waiting on you: {n}',
  'space.tier.error': 'finished with an error',
  'sidebar.state.needsYou': 'Waiting for you',
  'sidebar.state.finished': 'Finished',
  'sidebar.state.background': 'In background',
  'sidebar.state.working': 'At work',
  'sidebar.state.rest': 'The rest',
  'inbox.title': 'To look at',
  'inbox.button.count': 'To look at: {n}, {m} waiting for you',
  'inbox.tab.now': 'Now',
  'inbox.tab.history': 'History',
  'inbox.empty': 'Nothing to look at',
  'inbox.section.waiting': 'Waiting for you',
  'inbox.section.finished': 'Finished',
  'inbox.markAll': 'Mark all seen',
  'inbox.markAll.hint': 'Mark the finished ones listed here as seen (⇧E)',
  'inbox.markSeen': 'Mark seen (E)',
  'inbox.markSeenOf': 'Mark seen: {name}',
  'inbox.messages': '{n} messages',
  'inbox.reason.question': 'Has a question for you',
  'inbox.reason.permission': 'Asks for a permission',
  'inbox.reason.plan': 'Has a plan to approve',
  'inbox.reason.review': 'Ready for review',
  'inbox.reason.parked': 'Parked',
  'inbox.reason.done': 'Finished',
  'inbox.reason.error': 'Finished with an error',
  'inbox.quiet.background': '{n} in background',
  'inbox.quiet.working': '{n} at work',
  'inbox.quiet.inBackground': 'in background',
  'inbox.quiet.atWork': 'at work',
  'inbox.task.bash': 'Bash',
  'inbox.task.agent': 'Agent',
  'inbox.task.workflow': 'Workflow',
  'inbox.task.monitor': 'Monitor',
  'inbox.task.cron': 'Cron',
  'inbox.task.command': 'Command',
  'inbox.task.wake': 'Wake',
  'inbox.day.today': 'Today',
  'inbox.day.yesterday': 'Yesterday',
  'inbox.system': 'System',
};

export default ATTENTION_EN;
