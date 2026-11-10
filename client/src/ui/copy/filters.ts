/**
 * The one filter bar of the preview and the controls it is built from: the
 * search that suggests while typing, the filters as tokens (field, condition,
 * value), the saved filters, and the secondary navigation of a section.
 * Values in `i18n-ui-filters-it.ts` and `i18n-ui-filters-en.ts`.
 */
export interface FiltersCopy {
  /** Language of the words, for the date picker the value step uses. */
  lang: 'it' | 'en';
  /** The accessible name of the bar. */
  label: string;
  /** Placeholder of the filter box when the list does not name what it filters. It filters the list on show; the search over everything is the palette (Cmd+K). */
  search: string;
  /** Accessible name of the filter box. */
  searchLabel: string;
  /** Placeholder of the filter box of each list: it says what it filters. */
  on: { cards: string; flows: string; contracts: string; deadlines: string; programs: string; people: string; documents: string; rows: string; tables: string; log: string };
  /** Accessible name of the list of suggestions. */
  suggestionsLabel: string;
  /** The control that empties the search box. */
  clearSearch: string;
  /** The button that starts a new filter. */
  addFilter: string;
  addFilterLabel: string;
  /** The three steps of a filter, as their headings. */
  stepField: string;
  stepOp: string;
  stepValue: string;
  back: string;
  pickFieldPlaceholder: string;
  pickValuePlaceholder: string;
  /** Nothing in the list matches what was typed. */
  noMatch: string;
  /** A field has no value to pick yet. */
  noValues: string;
  apply: string;
  textLabel: string;
  dateLabel: string;
  daysLabel: string;
  /** The words of each condition, as read between the field and the value. */
  ops: { is: string; not: string; contains: string; before: string; after: string; within: string };
  /** The value of a `within` filter, as read on the token. */
  days: (n: number) => string;
  removeToken: (label: string) => string;
  editField: (field: string) => string;
  editOp: (field: string) => string;
  editValue: (field: string) => string;
  /** The saved filters, as pills. */
  savedLabel: string;
  removeSaved: (name: string) => string;
  save: string;
  saveTitle: string;
  saveName: string;
  saveNamePlaceholder: string;
  saveConfirm: string;
  clear: string;
  /** How many items show: `shown` of `total`, or all of them. */
  results: (shown: number, total: number) => string;
  /** Words of the live example in the kit page. */
  demo: {
    title: string;
    subNavLabel: string;
    sections: [string, string, string, string];
    viewList: string;
    viewBoard: string;
    viewLabel: string;
    savedBlocked: string;
    savedMine: string;
    empty: string;
    fields: { card: string; flow: string; state: string; person: string; due: string; place: string };
    states: { open: string; working: string; check: string; done: string };
    flows: { waste: string; invoices: string; tenders: string };
  };
}
