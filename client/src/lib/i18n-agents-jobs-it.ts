/**
 * client/src/lib/i18n-agents-jobs-it.ts - the strings of «Agenti e lavori»
 * (hub-smistamento, HUBBR-13): the three filters, the sections, the rows of
 * Topics, the proxy, the hub's queue and the workflows; in Italian, the
 * mirror of `i18n-agents-jobs-en.ts`.
 *
 * Loaded with the level's own chunk (`addCatalogue` in `i18n.ts`). A leaf: it
 * takes its type from `i18n-types.ts` and imports nothing else.
 */
import type { Dict } from './i18n-types';

const AGENTS_JOBS_IT: Dict = {
  'agentsJobs.updated': 'aggiornato ora',
  'agentsJobs.reading': 'lettura in corso',
  'agentsJobs.hubDown': 'Hub non raggiungibile: vedi solo Topics',
  'agentsJobs.retry': 'Riprova',
  'agentsJobs.filter.running': 'In corso',
  'agentsJobs.filter.waiting': 'In attesa',
  'agentsJobs.filter.finished': 'Finiti',
  'agentsJobs.band': '{n} aspettano te',
  'agentsJobs.bandOne': '1 aspetta te',
  'agentsJobs.section.topics': 'Sessioni Topics',
  'agentsJobs.section.topics.hint': 'qui dentro',
  'agentsJobs.section.proxy': 'Sessioni del proxy',
  'agentsJobs.section.proxy.hint': 'fuori da Topics',
  'agentsJobs.section.queue': 'Coda dell\'hub',
  'agentsJobs.section.queue.hint': 'lavori delegati',
  'agentsJobs.section.workflows': 'Workflow',
  'agentsJobs.section.decide': 'Decidi tu',
  'agentsJobs.section.decide.hint': 'ti aspettano',
  'agentsJobs.section.line': 'In coda',
  'agentsJobs.section.line.hint': 'partono da soli',
  'agentsJobs.section.quota': 'Ferme per quota',
  'agentsJobs.section.quota.hint': 'ripartono da sole',
  'agentsJobs.section.failed': 'Falliti',
  'agentsJobs.section.failed.hint': 'da guardare',
  'agentsJobs.section.today': 'Oggi',
  'agentsJobs.section.yesterday': 'Ieri',
  'agentsJobs.empty.running': 'Nessun agente al lavoro adesso',
  'agentsJobs.empty.waiting': 'Niente ti aspetta e niente è in coda',
  'agentsJobs.empty.finished': 'Niente di finito oggi o ieri',
  'agentsJobs.more': 'Altri {n}',
  'agentsJobs.src.topic': 'Sessione Topics',
  'agentsJobs.src.terminal': 'Terminale',
  'agentsJobs.src.proxy': 'Proxy',
  'agentsJobs.src.queue': 'Coda dell\'hub',
  'agentsJobs.src.workflow': 'Workflow',
  'agentsJobs.fallback.job': 'Lavoro delegato',
  'agentsJobs.fallback.jobOn': 'Lavoro delegato su {project}',
  'agentsJobs.fallback.proxy': 'Sessione Claude fuori da Topics',
  'agentsJobs.meta.waitsYou': 'ti aspetta',
  'agentsJobs.meta.finishedTurn': 'turno finito, da guardare',
  'agentsJobs.meta.noExecutor': 'in attesa di un esecutore',
  'agentsJobs.meta.restarts': 'riparte da sola',
  'agentsJobs.meta.exit': 'uscito con codice {n}',
  'agentsJobs.meta.requests': '{n} richieste',
  'agentsJobs.meta.requestsOne': '1 richiesta',
  'agentsJobs.meta.tokens': '{n} tok',
  'agentsJobs.chip.quota': 'quota',
  'agentsJobs.chip.failed': 'fallito',
  'agentsJobs.openChat': 'Apri la chat',
  'agentsJobs.openTerminal': 'Apri il terminale',
  'agentsJobs.withdraw': 'Togli dalla coda',
  'agentsJobs.withdrawFailed': 'Non tolto: l\'hub non ha risposto',
  'agentsJobs.rank': '{n}°',
  'agentsJobs.min': '{n} min',
  'agentsJobs.hours': '{h} h {m}',
  'agentsJobs.footer': 'Le card della notte restano sulla',
  'agentsJobs.footer.board': 'Board',
};

export default AGENTS_JOBS_IT;
