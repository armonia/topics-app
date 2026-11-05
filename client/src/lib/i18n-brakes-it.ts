/**
 * client/src/lib/i18n-brakes-it.ts - the strings of the board's «Frenato» chip
 * (hub-smistamento, HUBBR-20) in Italian, the mirror of `i18n-brakes-en.ts`.
 *
 * Loaded with the board's own chunk (`addCatalogue` in `i18n.ts`). A leaf: it
 * takes its type from `i18n-types.ts` and imports nothing else.
 */
import type { Dict } from './i18n-types';

const BRAKES_IT: Dict = {
  'brake.chip': 'Frenato',
  'brake.both': '{a} e {b}',
  'brake.why.share': 'quota {window} al {pct}%, riparte {when}',
  'brake.why.spent': 'quota {window} esaurita, riparte {when}',
  'brake.why.plan': 'limite del piano raggiunto, riparte {when}',
  'brake.why.apiDown': "l'API non risponde, riparte appena torna",
  'brake.why.next': 'riparte {when}',
  'brake.window.five_hour': '5h',
  'brake.window.seven_day': 'della settimana',
  'brake.when.today': 'alle {time}',
  'brake.when.tomorrow': 'domani alle {time}',
  'brake.when.later': '{day} alle {time}',
  'brake.threshold': 'soglia {pct}%',
  'brake.title': 'Le card di {who} aspettano in Todo',
  'brake.pop.title': 'Chi può partire adesso',
  'brake.pop.lead': 'Il tetto non cambia. Le card di {who} aspettano in Todo e ripartono da sole, le altre partono normalmente.',
  'brake.pop.held': 'Frenato',
  'brake.pop.free': 'Libero',
  'brake.pop.freeDetail': 'Le sue card partono normalmente',
  'brake.pop.accounts': 'Account e quote',
};

export default BRAKES_IT;
