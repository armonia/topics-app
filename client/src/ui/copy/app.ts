/**
 * Words of the container of the preview: search, notifications, the people
 * switcher, a place the current person may not open, the phone layout, the
 * settings sections. Values in `i18n-ui-app-it.ts` and `i18n-ui-app-en.ts`.
 */

/** The sections of Settings, in the order of the list. */
export type SettingsSection =
  | 'generale' | 'aspetto' | 'prodotto' | 'settore' | 'avvio' // allow-italian: identifier compared by value, not shown
  | 'persone' | 'squadra' | 'struttura' | 'condivisioni'
  | 'sicurezza' | 'dove-gira' | 'anonimizzazione' | 'conformita' | 'registro';

/** The kinds of thing the global search finds, in the order its results are grouped. */
export type SearchKind = 'card' | 'flussi' | 'documenti' | 'dati' | 'persone' | 'programmi' | 'impostazioni'; // allow-italian: identifiers compared by value, not shown

export interface AppCopy {
  search: {
    placeholder: string;
    shortcut: string;
    recent: string;
    /** The heading of the useful entries shown while the field is empty. */
    suggested: string;
    empty: (q: string) => string;
    emptyHint: string;
    seeAll: (q: string) => string;
    resultsTitle: (q: string) => string;
    count: (n: number) => string;
    /** The heading of each kind of result. */
    groups: Record<SearchKind, string>;
    /** The row that opens every result of a kind: `Altri 12`. allow-italian: quotes the words on screen */
    more: (n: number) => string;
    /** The title of the page with only the results of one kind. */
    kindTitle: (group: string, q: string) => string;
    /** The link back from that page to every kind. */
    allKinds: string;
    /** What the footer of the palette says about the result list. */
    footerCount: (n: number) => string;
    /** The lines under a result, where a kind says more than its name. */
    detail: {
      expires: (day: string) => string;
      agent: string;
      team: string;
      step: (n: number, flow: string) => string;
      openCards: (n: number) => string;
      clause: (contract: string) => string;
      part: (doc: string) => string;
      /** What a document is, before the line of context where the word was found. */
      docKind: { norme: string; azienda: string; procedure: string };
    };
    /** The entries offered while the field is empty. */
    suggest: {
      stuck: (n: number) => string;
      stuckOldest: (title: string, since: string) => string;
      dueSoon: (n: number) => string;
      /** The first of the week's deadlines: `late` when its day has passed (the list is oldest first, so it is the most overdue). */
      dueFirst: (title: string, day: string, late: boolean) => string;
      busiest: (flow: string) => string;
      busiestHint: (n: number) => string;
      newChat: string;
      newChatHint: string;
    };
  };
  notifications: {
    title: string;
    markAllRead: string;
    empty: string;
    unread: (n: number) => string;
  };
  persona: {
    switchTitle: string;
    current: string;
    example: string;
    switched: (name: string) => string;
    switchedBody: string;
    /** The line the log keeps when someone enters as another person. */
    auditLine: (name: string) => string;
  };
  access: {
    title: string;
    body: (role: string) => string;
    askWho: string;
    goHome: string;
    deniedAction: (role: string) => string;
  };
  error: {
    title: string;
    body: string;
    retry: string;
  };
  notFound: {
    title: string;
    body: string;
  };
  phone: {
    menu: string;
    back: string;
    nav: { today: string; inbox: string; search: string; board: string; more: string };
  };
  settingsRoot: string;
  settingsGroups: { org: string; people: string; rules: string; topics: string };
  settingsSections: Record<SettingsSection, string>;
  jobs: { running: string; done: string; failed: string };
  newTab: { title: string; recent: string; places: string };
  orgHome: string;
  cancel: string;
  time: { now: string; minutes: (n: number) => string; hours: (n: number) => string; yesterday: string; days: (n: number) => string };
}
