/**
 * client/src/lib/i18n-loadscreen-it.ts - the strings of the load screen
 * (`/schermo`), the monitor of a machine that takes the load; in Italian, the
 * mirror of `i18n-loadscreen-en.ts`. Added by the screen's own chunk.
 */
import type { Dict } from './i18n-types';

const LOAD_SCREEN_IT: Dict = {
  'loadScreen.title': 'Schermo del carico',
  'loadScreen.updated': 'aggiornato alle {time}',
  'loadScreen.reading': 'Lettura in corso',
  'loadScreen.state.working': 'Sta lavorando',
  'loadScreen.state.workingSub': '{cards} · {jobs}',
  'loadScreen.state.cards': '{n} card',
  'loadScreen.state.card': '1 card',
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
  'loadScreen.why': 'Perché è sveglio',
  'loadScreen.running': 'In corso',
  'loadScreen.running.none': 'Niente in corso su questa macchina',
  'loadScreen.running.since': 'da {time}',
  'loadScreen.running.lessThanMinute': 'da meno di un minuto',
  'loadScreen.running.minutes': '{m} min',
  'loadScreen.running.hours': '{h} h {m} min',
  'loadScreen.running.from': 'da {who}',
  'loadScreen.running.more': 'e altri {n} in corso',
  'loadScreen.running.job': 'Lavoro mandato',
  'loadScreen.weight': 'Chi pesa',
  'loadScreen.weight.sub': '{n} processi · {cores} core · {mem} di memoria',
  'loadScreen.weight.metric.rss': 'memoria residente per programma',
  'loadScreen.weight.metric.working-set': 'memoria in uso (working set) per programma',
  'loadScreen.weight.processes': '{n} processi',
  'loadScreen.weight.rest': 'Altri {n} processi · {mem}',
  'loadScreen.weight.unread': 'Processi non letti: la macchina non risponde',
  'loadScreen.weight.notPaired': 'Processi non letti: la macchina non è accoppiata',
  'loadScreen.pace': 'Ritmo delle quote',
  'loadScreen.pace.none': "Ritmo non letto: l'hub non risponde",
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
