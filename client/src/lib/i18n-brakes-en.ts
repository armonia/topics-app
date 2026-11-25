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
  'brake.pop.lead': 'The cap does not change. The cards of {who} wait in Todo, the other classes start as usual.',
  'brake.pop.leadCap': 'The cap stays at {cap}. The cards of {who} wait in Todo, the other classes start as usual.',
  'brake.pop.lift': 'Lift the brake on {who}',
  'brake.pop.held': 'Held',
  'brake.pop.free': 'Free',
  'brake.pop.freeDetail': 'Its cards start as usual',
  'brake.pop.accounts': 'Accounts and quotas',
  'brake.cards.wait': '{n} cards wait',
  'brake.cards.waitOne': '1 card waits',
  'brake.cards.work': '{n} cards at work',
  'brake.cards.workOne': '1 card at work',
  'brake.cards.workNone': 'no card at work',
  'brake.pop.noCard': 'no card held right now',
  'brake.pop.share': '5h quota at {pct}%',
  'brake.pop.fixed': 'Fixed quota',
  'brake.suite.name': 'Suites and builds',
  'brake.suite.pc': 'On the PC',
  'brake.suite.mac': 'On the Mac',
  'brake.suite.pcLoad': 'Mac loaded ({load} per core): the heavy jobs of the cards go to the PC.',
  'brake.suite.pcWhy': 'Mac under strain: the heavy jobs of the cards go to the PC.',
  'brake.suite.macDetail': 'Mac calm: the heavy jobs of the cards run here.',
  'brake.column.head': '{n} wait for the brake on {who}',
  'brake.column.headOne': '1 waits for the brake on {who}',
  'brake.column.tail': 'They start by themselves {when}.',
  'brake.column.tailOne': 'It starts by itself {when}.',
  'brake.column.api': 'They start as soon as the API answers again.',
  'brake.column.apiOne': 'It starts as soon as the API answers again.',
  'brake.card.wait': 'Waits for the brake · {who}',
  'brake.spend.who': 'Spend 24 h',
  'brake.spend.title': 'The 24-hour spend cap stops the queue',
  'brake.why.spend': '{spent} of {cap} USD, resumes {when}',
  'brake.why.spendOpen': '{spent} of {cap} USD, resumes when it falls back',
  'brake.pop.leadSpend': 'Agent spend over the last 24 hours went past the cap: no card starts, whatever its model. The cap is changed in the board settings.',
  'brake.column.spendHead': '{n} wait for the spend cap',
  'brake.column.spendHeadOne': '1 waits for the spend cap',
  'brake.column.spendOpen': 'They start when the 24-hour spend falls back under the cap.',
  'brake.column.spendOpenOne': 'It starts when the 24-hour spend falls back under the cap.',
  'brake.card.spend': 'Waits for the spend cap',
};

export default BRAKES_EN;
