/**
 * client/src/lib/i18n-hub-context-en.ts - the strings of the hub's rows in
 * System and of the agents' context (hub-smistamento, HUBBR-17) in English,
 * the mirror of `i18n-hub-context-it.ts`.
 *
 * Loaded with the rows' own chunk (`addCatalogue` in `i18n.ts`). A leaf: it
 * takes its type from `i18n-types.ts` and imports nothing else.
 */
import type { Dict } from './i18n-types';

const HUB_CONTEXT_EN: Dict = {
  'hubContext.open': "Agents' context",
  'hubContext.tail': '{n} tok at start',
  'hubContext.featuresTail': 'Jarvis behind on {n}',
  'hubContext.back': 'System',
  'hubContext.close': 'Close',
  'hubContext.reading': 'reading',
  'hubContext.readAt': 'read at {time}',
  'hubContext.hubDown': 'Hub not reachable',
  'hubContext.hubDownSince': 'Hub down · data from {time}',
  'hubContext.retry': 'Retry',
  'hubContext.empty': 'The hub has not read the context yet',
  'hubContext.tok': '{n} tok',
  'hubContext.weight': 'Weight per harness',
  'hubContext.weight.hint': 'read before the first word',
  'hubContext.weight.home': '+{n} tok in sessions opened in the home folder',
  'hubContext.weight.some': '+{n} tok in some sessions',
  'hubContext.contradictions': 'Contradictions',
  'hubContext.check.at': 'checked {when}',
  'hubContext.check.never': 'The rules have never been compared with each other.',
  'hubContext.check.none': 'No contradiction at the last check.',
  'hubContext.check.go': 'Look for contradictions',
  'hubContext.check.again': 'Check again',
  'hubContext.check.confirm': 'An agent reads every rule and looks for the ones that contradict each other. It takes a few minutes and uses quota.',
  'hubContext.check.start': 'Start the check',
  'hubContext.check.cancel': 'Cancel',
  'hubContext.check.running': 'An agent is reading the rules',
  'hubContext.check.runningHint': 'contradictions arrive here and in the bell',
  'hubContext.check.failed': 'The check did not start: {why}',
  'hubContext.check.lastFailed': 'The last check did not finish: {why}',
  'hubContext.check.vs': 'against',
  'hubContext.files': 'Read at start',
  'hubContext.files.hint': 'tap to read',
  'hubContext.skills': 'List of skills',
  'hubContext.skills.meta': '{n} skills, name and description',
  'hubContext.onDemand': 'Read on demand',
  'hubContext.onDemand.hint': 'they weigh nothing until opened',
  'hubContext.more': '{n} more',
  'hubContext.less': 'show less',
  'hubContext.duplicates': 'Duplicates',
  'hubContext.duplicates.hint': 'the same line in more files',
  'hubContext.duplicates.none': 'No line repeated across the files.',
  'hubContext.oldRules': 'Old rules',
  'hubContext.oldRules.hint': 'with a date over 45 days old',
  'hubContext.oldRules.meta': '{where} · {days} days ago',
  'hubContext.where.rules': '{owner} rules',
  'hubContext.where.profile': '{owner} profile',
  'hubContext.where.memory': '{owner} memory',
  'hubContext.where.other': '{name} of {owner}',
  'hubContext.where.bare': '{name}',
  'hubContext.doctor.ok': '{n} link checks: all green',
  'hubContext.doctor.fail': 'To fix',
  'hubContext.text.loading': 'opening the text',
  'hubContext.text.failed': 'The text of this file cannot be read from here.',
  'hubContext.when.today': 'today at {time}',
  'hubContext.when.day': 'on {date} at {time}',
};

export default HUB_CONTEXT_EN;
