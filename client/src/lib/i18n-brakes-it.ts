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
  'brake.pop.lead': 'Il tetto non cambia. Le card di {who} aspettano in Todo, le altre classi partono normalmente.',
  'brake.pop.leadCap': 'Il tetto resta {cap}. Le card di {who} aspettano in Todo, le altre classi partono normalmente.',
  'brake.pop.lift': 'Togli il freno a {who}',
  'brake.pop.held': 'Frenato',
  'brake.pop.free': 'Libero',
  'brake.pop.freeDetail': 'Le sue card partono normalmente',
  'brake.pop.accounts': 'Account e quote',
  'brake.cards.wait': '{n} card aspettano',
  'brake.cards.waitOne': '1 card aspetta',
  'brake.cards.work': '{n} card al lavoro',
  'brake.cards.workOne': '1 card al lavoro',
  'brake.cards.workNone': 'nessuna card al lavoro',
  'brake.pop.noCard': 'nessuna card ferma adesso',
  'brake.pop.share': 'Quota 5h al {pct}%',
  'brake.pop.fixed': 'Quota fissa',
  'brake.suite.name': 'Suite e build',
  'brake.suite.pc': 'Sul PC',
  'brake.suite.mac': 'Sul Mac',
  'brake.suite.pcLoad': 'Mac carico ({load} per core): i lavori pesanti delle card vanno sul PC.',
  'brake.suite.pcWhy': 'Mac sotto sforzo: i lavori pesanti delle card vanno sul PC.',
  'brake.suite.macDetail': 'Mac tranquillo: i lavori pesanti delle card girano qui.',
  'brake.column.head': '{n} aspettano il freno di {who}',
  'brake.column.headOne': '1 aspetta il freno di {who}',
  'brake.column.tail': 'Partono da sole {when}.',
  'brake.column.tailOne': 'Parte da sola {when}.',
  'brake.column.api': "Partono appena l'API torna a rispondere.",
  'brake.column.apiOne': "Parte appena l'API torna a rispondere.",
  'brake.card.wait': 'Aspetta il freno · {who}',
};

export default BRAKES_IT;
