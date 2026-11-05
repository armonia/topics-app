/**
 * client/src/lib/i18n-brakes-en.ts - the strings of the board's «Frenato» chip
 * (hub-smistamento, HUBBR-20) in English, the mirror of `i18n-brakes-it.ts`.
 *
 * Loaded with the board's own chunk (`addCatalogue` in `i18n.ts`). A leaf: it
 * takes its type from `i18n-types.ts` and imports nothing else.
 */
import type { Dict } from './i18n-types';

const BRAKES_EN: Dict = {
  'brake.chip': 'Held',
  'brake.both': '{a} and {b}',
  'brake.why.share': '{window} quota at {pct}%, resumes {when}',
  'brake.why.spent': '{window} quota spent, resumes {when}',
  'brake.why.plan': 'plan limit reached, resumes {when}',
  'brake.why.apiDown': 'the API is not answering, resumes when it is back',
  'brake.why.next': 'resumes {when}',
  'brake.window.five_hour': '5h',
  'brake.window.seven_day': 'weekly',
  'brake.when.today': 'at {time}',
  'brake.when.tomorrow': 'tomorrow at {time}',
  'brake.when.later': '{day} at {time}',
  'brake.threshold': 'threshold {pct}%',
  'brake.title': 'The cards of {who} wait in Todo',
  'brake.pop.title': 'Who can start now',
  'brake.pop.lead': 'The cap does not change. The cards of {who} wait in Todo and start again by themselves, the others start as usual.',
  'brake.pop.held': 'Held',
  'brake.pop.free': 'Free',
  'brake.pop.freeDetail': 'Its cards start as usual',
  'brake.pop.accounts': 'Accounts and quotas',
};

export default BRAKES_EN;
