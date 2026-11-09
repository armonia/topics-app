/**
 * client/src/lib/i18n-loadscreen-it.ts - the strings of the load screen
 * (`/schermo`), the monitor of a machine that takes the load; in Italian, the
 * mirror of `i18n-loadscreen-en.ts`. Added by the screen's own chunk.
 */
import type { Dict } from './i18n-types';

const LOAD_SCREEN_IT: Dict = {
  'loadScreen.updated': 'aggiornato alle {time}',
  'loadScreen.reading': 'Lettura in corso',
  'loadScreen.state.sessions': '{n} sessioni',
  'loadScreen.state.noSessions': 'nessuna sessione',
  'loadScreen.state.session': '1 sessione',
  'loadScreen.state.workingSub': '{sessions} · {jobs}',
  'loadScreen.sent': 'Lavoro dal Mac',
  'loadScreen.sent.job': 'Lavoro mandato',
  'loadScreen.sent.from': 'da {who}',
  'loadScreen.sent.since': 'da {time}',
  'loadScreen.state.working': 'Sta lavorando',
  'loadScreen.state.jobs': '{n} lavori mandati',
  'loadScreen.state.job': '1 lavoro mandato',
  'loadScreen.state.noJobs': 'nessun lavoro mandato',
  'loadScreen.state.countdown': 'Dorme fra {n} min',
  'loadScreen.state.countdownSub': 'alle {time}, dopo {threshold} min senza lavoro',
  'loadScreen.state.countdownSubBare': 'alle {time}',
  'loadScreen.state.sleeping': 'Si sta addormentando',
  'loadScreen.state.idle': 'Senza lavoro',
  'loadScreen.state.idleSub': 'dorme dopo {threshold} min senza lavoro',
  'loadScreen.state.idleSubBare': 'il conto alla rovescia non arriva',
  'loadScreen.weight': 'Chi pesa',
  'loadScreen.weight.sub': '{n} processi · {cores} core · {mem} di memoria',
  'loadScreen.weight.metric.rss': 'memoria residente per programma',
  'loadScreen.weight.metric.working-set': 'memoria in uso (working set) per programma',
  'loadScreen.weight.cpuNote': 'CPU in % di un core',
  'loadScreen.weight.fromMac': 'dal Mac',
  'loadScreen.weight.processes': '{n} processi',
  'loadScreen.weight.rest': 'Altri {n} processi · {mem}',
  'loadScreen.weight.unread': 'Processi non letti: la macchina non risponde',
  'loadScreen.weight.notPaired': 'Processi non letti: la macchina non è accoppiata',
  'loadScreen.outcomes': 'Ultimi esiti',
  'loadScreen.outcome.ok': 'riuscito',
  'loadScreen.outcome.failed': 'fallito',
  'loadScreen.outcome.unknown': 'esito non detto',
  'loadScreen.outcome.interrupted': 'interrotto',
  'loadScreen.outcome.seconds': '{n} s',
  'loadScreen.outcome.minutes': '{m} min {s} s',
  'loadScreen.hubDown': "L'hub non risponde: stato e misure sono dell'ultima lettura",
};

export default LOAD_SCREEN_IT;
