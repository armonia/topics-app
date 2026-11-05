/**
 * client/src/lib/i18n-features-en.ts - the strings of the feature map
 * (hub-smistamento, HUBBR-18) in English, the mirror of `i18n-features-it.ts`.
 *
 * Loaded with the view's own chunk (`addCatalogue` in `i18n.ts`). A leaf: it
 * takes its type from `i18n-types.ts` and imports nothing else.
 */
import type { Dict } from './i18n-types';

const FEATURES_EN: Dict = {
  'feat.verdict.behind': '{n} where Jarvis is behind',
  'feat.verdict.rest': ', out of {total} features',
  'feat.verdict.none': 'Jarvis is behind on none of the {total} features',
  'feat.verdict.systems': '{n} systems compared',
  'feat.verdict.ours': 'Jarvis covers {pct}%, place {rank}',
  'feat.verdict.updated': 'map of {date}',
  'feat.live': 'read at {time}',
  'feat.reading': 'reading the map',
  'feat.hubDown': 'Hub not reachable · data from {time}',
  'feat.hubDownNever': 'Hub not reachable: the map cannot be read',
  'feat.retry': 'Retry',
  'feat.ranking': 'Ranking',
  'feat.ranking.hint': 'share of the known features each one covers',
  'feat.filter.behind': 'Where it is behind',
  'feat.filter.all': 'All',
  'feat.search': 'search a feature',
  'feat.area.hint': 'Jarvis {pct}%, {rank} of {of}',
  'feat.status.yes': 'Yes',
  'feat.status.partial': 'Partly',
  'feat.status.no': 'No',
  'feat.status.unknown': 'Unknown',
  'feat.have': '{n} of {of} have it',
  'feat.newsOne': '1 news item',
  'feat.news': '{n} news items',
  'feat.withIt': 'Have it',
  'feat.partly': 'Partly',
  'feat.nobody': 'nobody',
  'feat.newsTitle': 'News',
  'feat.newsHint': 'from the changelogs, as written',
  'feat.empty': 'No feature with this filter.',
  'feat.ourStatus': 'Jarvis',
};

export default FEATURES_EN;
