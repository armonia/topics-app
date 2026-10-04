/**
 * client/src/lib/i18n-attention-it.ts - the strings of the attention state
 * (change notifications-redesign): the inbox «Da guardare», the sections of
 * the state view, the tier a tab names; in Italian, the mirror of
 * `i18n-attention-en.ts`.
 *
 * A leaf like `i18n-find-it.ts`: it takes its type from `i18n-types.ts` and
 * imports nothing else, so it travels with its catalogue.
 */
import type { Dict } from './i18n-types';

const ATTENTION_IT: Dict = {
  'attention.state.needsYou': 'ti aspetta',
  'attention.state.error': 'finito con un errore',
  'attention.state.done': 'ha finito',
  'attention.project.lookAt': '{n} da guardare',
  'attention.project.more': '+altri {n}',
  'attention.board.waiting': 'Ti aspettano: {n}',
  'space.tier.error': 'finito con un errore',
  'sidebar.state.needsYou': 'Ti aspetta',
  'sidebar.state.finished': 'Finite',
  'sidebar.state.working': 'Al lavoro',
  'sidebar.state.rest': 'Il resto',
  'inbox.title': 'Da guardare',
  'inbox.button.count': 'Da guardare: {n}, di cui {m} ti aspettano',
  'inbox.tab.now': 'Ora',
  'inbox.tab.history': 'Cronologia',
  'inbox.empty': 'Niente da guardare',
  'inbox.section.waiting': 'Ti aspettano',
  'inbox.section.finished': 'Finite',
  'inbox.markAll': 'Segna tutte viste',
  'inbox.markAll.hint': 'Segna viste le finite elencate qui (⇧E)',
  'inbox.markSeen': 'Segna visto (E)',
  'inbox.markSeenOf': 'Segna visto: {name}',
  'inbox.messages': '{n} messaggi',
  'inbox.reason.question': 'Ha una domanda per te',
  'inbox.reason.permission': 'Chiede un permesso',
  'inbox.reason.plan': 'Ha un piano da approvare',
  'inbox.reason.review': 'Pronta per la review',
  'inbox.reason.parked': 'Parcheggiata',
  'inbox.reason.done': 'Ha finito',
  'inbox.reason.error': 'Finito con un errore',
  'inbox.quiet.working': '{n} al lavoro',
  'inbox.quiet.atWork': 'al lavoro',
  'inbox.task.bash': 'Bash',
  'inbox.task.agent': 'Agent',
  'inbox.task.workflow': 'Workflow',
  'inbox.task.monitor': 'Monitor',
  'inbox.task.cron': 'Cron',
  'inbox.task.command': 'Comando',
  'inbox.task.wake': 'Risveglio',
  'inbox.day.today': 'Oggi',
  'inbox.day.yesterday': 'Ieri',
  'inbox.system': 'Sistema',
};

export default ATTENTION_IT;
