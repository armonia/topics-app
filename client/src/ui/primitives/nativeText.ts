/*
 * The few words the native-free controls (Select, DatePicker) say on their own:
 * the search box of a long list, the buttons of the calendar, the names read
 * out by a screen reader. A control takes `lang` and looks them up here, so the
 * layer needs no i18n module; a screen that has its own words passes them in.
 */

export type ControlLanguage = 'it' | 'en';

export interface NativeText {
  /** Placeholder and accessible name of the search box of a long list. */
  search: string;
  /** Said in the list when the search matches nothing. */
  noResults: string;
  /** Shown in an empty date field, in the order the date is written. */
  datePlaceholder: string;
  /** Accessible name of the date field's calendar when the field has no label. */
  pickDate: string;
  today: string;
  clear: string;
  prevMonth: string;
  nextMonth: string;
}

export const NATIVE_TEXT: Record<ControlLanguage, NativeText> = {
  // allow-italian: the Italian words of the controls, shown as written
  it: {
    search: 'Cerca',
    noResults: 'Nessun risultato',
    datePlaceholder: 'gg/mm/aaaa',
    pickDate: 'Scegli una data',
    today: 'Oggi',
    clear: 'Cancella',
    prevMonth: 'Mese prima',
    nextMonth: 'Mese dopo',
  },
  en: {
    search: 'Search',
    noResults: 'No results',
    datePlaceholder: 'dd/mm/yyyy',
    pickDate: 'Pick a date',
    today: 'Today',
    clear: 'Clear',
    prevMonth: 'Previous month',
    nextMonth: 'Next month',
  },
};

/** The locale `Intl` formats month and day names in; both start the week on Monday. */
export const NATIVE_LOCALE: Record<ControlLanguage, string> = { it: 'it-IT', en: 'en-GB' };
