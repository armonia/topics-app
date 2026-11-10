/**
 * SARIM edition: «Programmi», «Squadra» (people, agents, permissions) and «Impostazioni». (allow-italian: quotes the Italian interface)
 * Values in `i18n-ui-sarim-admin-it.ts` and `i18n-ui-sarim-admin-en.ts`; only product words,
 * the words of SARIM's work arrive with the data.
 */
export type SarimProgramLinkWord = 'api' | 'file' | 'screen' | 'browser' | 'mailbox' | 'public';
export type SarimProgramGroupWord = 'territory' | 'staff' | 'office' | 'tenders' | 'public';
/** How a program connects, grouped the way the filter offers it (API and public services, files, robots, mailboxes). */
export type SarimProgramLinkGroup = 'api' | 'file' | 'screen' | 'browser' | 'mailbox' | 'public';
export type SarimProgramStateWord = 'connected' | 'disconnected' | 'testing' | 'failed' | 'connecting';
export type SarimSettingsSection = 'organizzazione' | 'agenti' | 'registro' | 'aspetto' | 'notifiche'; // allow-italian: address segments, compared by value
export type SarimNeverWord = 'sign' | 'send' | 'approve' | 'write';
export type SarimPrincipleAction = 'sign' | 'approveContract' | 'approve' | 'send' | 'registry' | 'tender' | 'programs';
export type SarimAlertWindow = 'd180' | 'd90' | 'd30';
export type SarimStuckScope = 'mine' | 'area' | 'all';

export interface SarimAdminCopy {
  title: string;

  common: {
    agent: string;
    you: string;
    open: string;
    blank: string;
    cards: (n: number) => string;
    flows: (n: number) => string;
    perMonth: (n: number) => string;
    since: (when: string) => string;
    neverTitle: string;
    never: Record<SarimNeverWord, { label: string; hint: string }>;
    searchGroups: { programs: string; people: string; agents: string; settings: string };
  };

  programs: {
    title: string;
    count: (n: number) => string;
    /** The fields of the filter bar. */
    fields: { link: string; state: string; flow: string };
    linkGroups: Record<SarimProgramLinkGroup, string>;
    groups: Record<SarimProgramGroupWord, string>;
    links: Record<SarimProgramLinkWord, string>;
    columns: { program: string; does: string; link: string; flows: string; open: string; state: string };
    /** What Topics reads and writes there, by name: `legge utenze e ordini · scrive ordini di servizio, con conferma`. allow-italian: quotes the words on screen */
    does: (gist: { reads: string; writes?: string }) => string;
    states: Record<SarimProgramStateWord, string>;
    lastRead: (when: string) => string;
    emptyTitle: string;
    emptyReset: string;
    side: {
      stateTitle: string;
      eventsTitle: string;
      eventsEmpty: string;
    };
    page: {
      external: (who: string) => string;
      readsTitle: string;
      writesTitle: string;
      writesNone: string;
      confirmedBy: string;
      flowsTitle: string;
      flowsEmpty: string;
      flowSteps: (n: number) => string;
      flowStatus: { attivo: string; collaudo: string; bozza: string }; // allow-italian: status codes of the data
      /** A flow paused on «Flussi»: shown in place of its status. (allow-italian: quotes the Italian interface) */
      flowPaused: string;
      cardsTitle: string;
      cardsEmpty: string;
      cardsByFlow: string;
      linkTitle: string;
      how: string;
      account: string;
      every: string;
      lastRead: string;
      source: string;
      test: string;
      retest: string;
      connect: string;
      disconnect: string;
      testOk: (when: string) => string;
      testFailed: string;
      historyTitle: string;
      historyEmpty: string;
      disconnectedNote: (flows: string) => string;
      notFound: string;
      notFoundBody: string;
      back: string;
    };
    jobs: {
      test: (name: string) => string;
      connect: (name: string) => string;
      connectSteps: string[];
    };
    toasts: {
      testOk: (name: string) => string;
      testOkBody: string;
      testFailed: (name: string) => string;
      connected: (name: string) => string;
      connectedBody: string;
      disconnected: (name: string) => string;
      disconnectedBody: string;
    };
    confirmDisconnect: {
      title: (name: string) => string;
      body: (name: string, flows: string) => string;
      bodyNoFlows: (name: string) => string;
      confirm: string;
    };
    events: {
      connected: string;
      disconnected: string;
      testOk: string;
      testFailed: (why: string) => string;
    };
    logs: {
      testOk: (name: string) => string;
      testFailed: (name: string) => string;
      connected: (name: string) => string;
      disconnected: (name: string) => string;
    };
  };

  team: {
    person: {
      back: string;
      notFound: string;
      notFoundBody: string;
      stats: { inHand: string; waiting: (n: number) => string; contracts: string; approvals: string };
      inHandTitle: string;
      inHandEmpty: string;
      waitingTitle: string;
      waitingEmpty: string;
      contractsTitle: string;
      contractsEmpty: string;
      owns: string;
      step: (action: string, state: string) => string;
      stepStates: { fatto: string; 'in-attesa': string; 'da-fare': string }; // allow-italian: state codes of the data
      obligationsTitle: string;
      obligationsEmpty: string;
      due: (day: string) => string;
      every: (text: string) => string;
      recentTitle: string;
      recentEmpty: string;
      openLog: string;
    };
    agent: {
      kind: string;
      stats: { inHand: string; waiting: (n: number) => string; closed: string; steps: string };
      stepsTitle: string;
      stepsBody: string;
      stepsEmpty: string;
      inHandTitle: string;
      inHandEmpty: string;
      waitingTitle: string;
      waitingEmpty: string;
      closedTitle: string;
      closedEmpty: string;
      reviewersTitle: string;
      reviewersBody: (n: number) => string;
      reviewersEmpty: string;
      programsTitle: string;
      programsEmpty: string;
      recentTitle: string;
    };
  };

  settings: {
    /** The root of the crumbs of the organization's pages. */
    org: string;
    /** The crumb of the organization's settings, and the label of the strip under it. */
    root: string;
    /** The crumb of the person's preferences, and the label of the strip under it. */
    prefsRoot: string;
    /** The group of the search results for the pages of the person. */
    prefsGroup: string;
    sections: Record<SarimSettingsSection, string>;
    search: Record<SarimSettingsSection, { detail: string; keywords: string }>;
    common: {
      saved: (label: string) => string;
      changedTo: (label: string, value: string) => string;
      on: string;
      off: string;
      onlyAdmin: string;
    };
    /** The interface language, chosen in Aspetto; the container reads it from the slice `settings.general`. */
    language: {
      label: string;
      note: string;
      options: { it: string; en: string };
    };
    organization: {
      identityTitle: string;
      sourceTitle: (quote: string) => string;
      numbersTitle: string;
      numbersBody: string;
      certificationsTitle: string;
      certificationsBody: string;
      expires: (day: string, days: number) => string;
      servedTitle: (n: number) => string;
      servedBody: string;
      /** The tooltip of a town: it opens its row in «Dati». (allow-italian: quotes the Italian interface) */
      servedOpen: (town: string) => string;
      teamsTitle: string;
      openTeam: string;
      areaPeople: (n: number) => string;
    };
    alerts: {
      contractsTitle: string;
      contractsBody: string;
      windows: Record<SarimAlertWindow, { label: string; hint: string }>;
      todayNone: string;
      todaySome: (n: number) => string;
      noticeLine: (date: string, days: number) => string;
      stuckTitle: string;
      stuckBody: string;
      stuckToggle: string;
      stuckScope: string;
      scopes: Record<SarimStuckScope, string>;
      stuckColumns: { flow: string; after: string; now: string };
      stuckAfter: (hours: number) => string;
      stuckNow: (n: number) => string;
      obligationsTitle: string;
      obligationsBody: string;
      obligationsToggle: string;
      obligationsWindow: string;
      obligationsDays: (n: number) => string;
      obligationsNow: (mine: number, all: number, days: number) => string;
      channelsTitle: string;
      channels: { bell: { label: string; hint: string }; mail: { label: string; hint: string }; phone: { label: string; hint: string } };
      test: string;
      testTitle: string;
      testBody: string;
      testToast: string;
    };
    /** Settings, Agents section (allow-italian: quotes the Italian interface): what the agents are doing now, and what they never do. */
    agents: {
      numbersTitle: string;
      numbers: { preparing: string; waiting: string; closedByAgent: string; closedByPerson: string };
      /** The cards closed in the last 7 days that a person went through first. */
      passed: (ok: number, total: number) => string;
      neverTitle: string;
      neverBody: string;
      actions: Record<SarimPrincipleAction, { title: string; body: string }>;
      whoCan: string;
      nobody: string;
      openPermissions: string;
      openProgram: string;
    };
    log: {
      subject: string;
      fileName: string;
      caseKind: string;
      /** The fields of the filter bar of the log. */
      fields: { who: string; person: string; kind: string; day: string };
      /** The values of «Chi»: who did it, by kind. */
      actors: { people: string; agents: string; programs: string };
      /** The values of «Cosa»: what was done, by kind. */
      kinds: { structure: string; access: string; work: string };
    };
  };

  /** The sentences of the log lines the world already holds (moves of cards, approvals, versions). */
  log: {
    cardArrived: (stage: string) => string;
    cardMoved: (stage: string) => string;
    cardClosed: string;
    contractStep: (action: string) => string;
    version: (n: number) => string;
  };
}
