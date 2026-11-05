/**
 * client/src/lib/i18n-features-it.ts - the strings of «Funzionalità»
 * (hub-smistamento, HUBBR-18): the comparison between the agent systems, where
 * Jarvis is behind; in Italian, the mirror of `i18n-features-en.ts`.
 *
 * Loaded with the view's own chunk (`addCatalogue` in `i18n.ts`). A leaf: it
 * takes its type from `i18n-types.ts` and imports nothing else.
 */
import type { Dict } from './i18n-types';

const FEATURES_IT: Dict = {
  'feat.verdict.behind': '{n} dove Jarvis è indietro',
  'feat.verdict.rest': ', su {total} voci',
  'feat.verdict.none': 'Jarvis non è indietro su nessuna delle {total} voci',
  'feat.verdict.systems': '{n} sistemi a confronto',
  'feat.verdict.ours': 'Jarvis copre il {pct}%, {rank}° posto',
  'feat.verdict.updated': 'mappa del {date}',
  'feat.live': 'letta alle {time}',
  'feat.reading': 'lettura della mappa',
  'feat.hubDown': 'Hub non raggiungibile · dati delle {time}',
  'feat.hubDownNever': 'Hub non raggiungibile: la mappa non si legge',
  'feat.retry': 'Riprova',
  'feat.ranking': 'Classifica',
  'feat.ranking.hint': 'quota delle voci note che ciascuno copre',
  'feat.filter.behind': 'Dove è indietro',
  'feat.filter.all': 'Tutte',
  'feat.search': 'cerca una funzionalità',
  'feat.area.hint': 'Jarvis {pct}%, {rank}° di {of}',
  'feat.status.yes': 'Sì',
  'feat.status.partial': 'In parte',
  'feat.status.no': 'No',
  'feat.status.unknown': 'Non noto',
  'feat.have': "ce l'hanno {n} su {of}",
  'feat.newsOne': '1 novità',
  'feat.news': '{n} novità',
  'feat.withIt': "Ce l'hanno",
  'feat.partly': 'In parte',
  'feat.nobody': 'nessuno',
  'feat.newsTitle': 'Novità',
  'feat.empty': 'Nessuna voce con questo filtro.',
  'feat.ourStatus': 'Jarvis',
};

export default FEATURES_IT;
