/**
 * client/src/lib/i18n-find-en.ts - the find bar's strings (change
 * find-in-page), in English; the mirror of `i18n-find-it.ts`.
 *
 * A leaf like `i18n-chat-en.ts`: it takes its type from `i18n-types.ts` and
 * imports nothing else, so it travels with its catalogue.
 */
import type { Dict } from './i18n-types';

const FIND_EN: Dict = {
  'find.label': 'Find',
  'find.bar': 'Find in this pane',
  'find.placeholder': 'Find here',
  'find.chat.placeholder': 'Find in chat',
  'find.terminal.placeholder': 'Find in terminal',
  'find.file.placeholder': 'Find in file',
  'find.counter': '{i} of {t}',
  'find.counter.over': 'over {n}',
  'find.replace.placeholder': 'Replace with',
  'find.replace.one': 'Replace',
  'find.replace.all': 'Replace all',
  'find.unavailable.video': "This page is an image here: find isn't available",
};

export default FIND_EN;
