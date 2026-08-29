/**
 * client/src/lib/i18n-spend-en.ts - the MONEY strings, in English.
 *
 * The mirror of `i18n-spend-it.ts`, which explains why the pair exists at all.
 * It stays a leaf like `i18n-en.ts`: it takes its type from `i18n-types.ts` and
 * imports nothing else, so it travels in the lazily loaded English chunk instead
 * of being pulled back into the eager bundle.
 */
import type { Dict } from './i18n-types';

const SPEND_EN: Dict = {
  'board.spend.title': 'Agent spend',
  'board.spend.window': '{amount} in the last 24h',
  'board.spend.total': '{amount} in all',
  'board.spend.unpriced': '{tokens} tokens with no price list: they are not in this figure.',
  'board.spend.capTask': 'Cap per card (USD)',
  'board.spend.capDay': 'Cap per machine, 24h (USD)',
  'board.spend.capNone': 'none',
  'board.spend.overDay': 'Daily cap passed ({spent} of {cap}): the next turn does not start.',
  'board.spend.leftDay': '{amount} left before the daily cap.',
  'board.spend.capTaskNote': 'A card that reaches {cap} does not start its next turn, and writes it in its thread.',
  'board.spend.noCaps': 'No cap: no brake, no warning. The number above shows anyway.',

  'cost.agent': 'Board agent',
  'cost.agentUnpriced': '(+{tokens} unpriced)',
};

export default SPEND_EN;
