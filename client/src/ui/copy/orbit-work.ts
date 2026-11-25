/**
 * ORBIT edition: «Oggi» (the day of a person) and «Flussi» (the flows and their steps). (allow-italian: quotes the Italian interface)
 * Values in `i18n-ui-orbit-work-it.ts` and `i18n-ui-orbit-work-en.ts`; only product words,
 * the words of ORBIT's work arrive with the data.
 */
export interface OrbitWorkCopy {
  title: string;
  /** Day names, Sunday first, as `Date.getUTCDay()` counts them. */
  weekdays: string[];
  /** Month names, January first. */
  months: string[];
  /** `venerdì 6 novembre`. (allow-italian: quotes the Italian interface) */
  dateLine: (weekday: string, day: number, month: string) => string;
  /** A moment of today or yesterday, said the short way: `oggi 09:41`, `ieri 15:00`, `02/11 15:00`. (allow-italian: quotes the Italian interface) */
  todayAt: (time: string) => string;
  yesterdayAt: (time: string) => string;
  /** How far a day is: `oggi`, `domani`, `5 gg`, `scaduta da 2 gg`. (allow-italian: quotes the Italian interface) */
  distance: (days: number) => string;
  flows: {
    /** The root of the crumbs of the flow pages. */
    org: string;
    title: string;
    count: (n: number) => string;
    /** The fields of the filter bar, and the filters that come with the list. */
    fields: { team: string; state: string; program: string; agent: string };
    clear: string;
    empty: string;
    columns: { flow: string; status: string; trigger: string; programs: string; agents: string; cards: string };
    versionSteps: (version: number, steps: number) => string;
    status: { active: string; testing: string; draft: string; paused: string };
    agentSteps: (agent: number, steps: number) => string;
    stuck: (n: number) => string;
    openCards: (n: number) => string;
    noCards: string;
    stepCount: (marker: string, title: string, n: number) => string;
    /** The hint of the last step: cards closed in the last 7 days, not work still to do. */
    stepDone: (marker: string, title: string, n: number) => string;
    stats: { running: string; runningDetail: (testing: number, paused: number) => string; open: string; openDetail: string; stuck: string; stuckDetail: string; agents: string; agentsDetail: (busy: number, all: number) => string };
    back: string;
    /** Opens the list of cards with this flow on the filter. */
    openInDaFare: string;
    tryYesterday: string;
    tryTitle: string;
    pause: string;
    resume: string;
    pauseConfirm: { title: (name: string) => string; body: string; label: string };
    pausedToast: (name: string) => string;
    resumedToast: (name: string) => string;
    pausedLog: (name: string) => string;
    resumedLog: (name: string) => string;
    pausedNotify: (name: string) => string;
    pausedNotifyBody: (who: string) => string;
    pausedBanner: (who: string, when: string) => string;
    volume: (n: string) => string;
    noCardsHere: string;
    more: (n: number) => string;
    rule: string;
    side: {
      tag: string;
      area: string;
      trigger: string;
      volume: string;
      version: string;
      programs: string;
      agents: string;
      /** The cards of the flow per stage of «Da fare»: the same counts as its kanban, which a row opens. (allow-italian: quotes the Italian interface) */
      stages: (flow: string) => string;
      stagesOpen: string;
      /** Who closed the cards now in «Fatto» (the last 7 days), as one sentence under the counts. (allow-italian: quotes the Italian interface) */
      closedBy: (agent: number, person: number) => string;
      noneClosed: string;
      lastTest: string;
      noTest: string;
    };
    test: {
      title: (name: string) => string;
      /** `fallback`: nothing moved that day, the try takes the last cases of the flow. */
      steps: (day: string, n: number, fallback: boolean) => string[];
      running: string;
      done: (name: string) => string;
      result: (total: number, same: number, look: number) => string;
      fallback: (n: number) => string;
      same: string;
      look: string;
      low: (label: string, confidence: number) => string;
      copyNote: string;
      log: (name: string, total: number, look: number) => string;
      at: (when: string, who: string) => string;
    };
    step: {
      /** The first two crumbs of a step: `ORBIT / Flussi`. (allow-italian: quotes the Italian interface) */
      org: string;
      flows: string;
      crumb: (n: string) => string;
      navLabel: string;
      who: string;
      does: string;
      reads: string;
      produces: string;
      nothing: string;
      column: string;
      stopsAfter: (hours: number) => string;
      /** The chip of a card that is stopped. */
      stopped: string;
      cardsNow: string;
      worker: string;
      reviewer: string;
      checkedAfter: string;
      noPersonAfter: string;
      openColumn: (stage: string) => string;
      prev: string;
      next: string;
      notFound: string;
      notFoundBody: string;
      backToFlow: string;
      programDoes: (program: string) => string;
      ruleDoes: string;
    };
    notFound: string;
    notFoundBody: string;
    backToFlows: string;
    searchFlows: string;
    searchSteps: string;
  };
}
