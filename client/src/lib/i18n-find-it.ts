/**
 * client/src/lib/i18n-find-it.ts - the find bar's strings (change
 * find-in-page), in Italian; the mirror of `i18n-find-en.ts`.
 *
 * A leaf like `i18n-chat-it.ts`: it takes its type from `i18n-types.ts` and
 * imports nothing else, so it travels with its catalogue.
 */
import type { Dict } from './i18n-types';

const FIND_IT: Dict = {
  'find.label': 'Cerca',
  'find.bar': 'Cerca in questa pane',
  'find.placeholder': 'Cerca qui',
  'find.chat.placeholder': 'Cerca nella chat',
  'find.terminal.placeholder': 'Cerca nel terminale',
  'find.file.placeholder': 'Cerca nel file',
  'find.counter': '{i} di {t}',
  'find.counter.over': 'oltre {n}',
  'find.replace.placeholder': 'Sostituisci con',
  'find.replace.one': 'Sostituisci',
  'find.replace.all': 'Sostituisci tutti',
  'find.unavailable.video': "Qui la pagina è un'immagine: la ricerca non c'è",
};

export default FIND_IT;
