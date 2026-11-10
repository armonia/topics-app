/**
 * Programs and agents: by area, the agent on the PC, smart search, migration, where agents run, remote control.
 * The words of the `programs` area of the preview; values in `i18n-ui-programs-it.ts`
 * and `i18n-ui-programs-en.ts`. Only product words: sector words arrive with the data.
 */
import type { ConnectionFamily, ConnectionKind, ProgramStateKind, Verdict } from '../programs/model';

export type AccessLabelKey = 'user' | 'tables' | 'lastCheck' | 'mailbox' | 'folder' | 'pc' | 'password' | 'scope';

export interface ProgramsCopy {
  /** Words used by more than one screen. */
  common: {
    programs: string;
    now: string;
    /** «oggi 06:00» */
    todayAt: (time: string) => string;
    /** A whole number with the dot every three digits, also at four digits. */
    number: (n: number) => string;
    /** «2 min» ago, as a last-seen label. */
    minutesAgo: (n: number) => string;
    months: (n: number) => string;
    connection: Record<ConnectionKind, string>;
    connectionAbout: Record<ConnectionKind, string>;
    family: Record<ConnectionFamily, string>;
    state: Record<ProgramStateKind, string>;
    verdict: Record<Verdict, string>;
    verdictAbout: Record<Verdict, string>;
    jobDone: string;
    jobFailed: string;
    jobRunning: string;
    jobSteps: (done: number, total: number) => string;
    searchGroup: string;
    searchOwns: (area: string, connection: string) => string;
  };
  /** w06: the list of programs by area. */
  list: {
    title: string;
    count: (n: number) => string;
    searchPlaceholder: string;
    add: string;
    filterLabel: string;
    filterAll: string;
    columns: { program: string; holds: string; connection: string; usedBy: string; state: string; alternatives: string };
    flows: (n: number) => string;
    /** A program a flow is meant to use but that is not connected yet. */
    flowsPlanned: (n: number) => string;
    channels: (n: number) => string;
    /** The word beside a channel in the «used by» list of a program. */
    channelWord: string;
    perMonth: (n: number) => string;
    /** The words for the state a flow is in, given its stored name. */
    flowStatus: (status: string) => string;
    noFlows: string;
    notUsed: string;
    emptyTitle: string;
    emptyBody: string;
    emptyReset: string;
    addFromQuery: (q: string) => string;
    passwordNew: (time: string) => string;
    passwordExpired: string;
    agentRemoved: string;
    detail: {
      tag: Record<ConnectionFamily, string>;
      reads: string;
      usedBy: string;
      access: string;
      accessLabels: Record<AccessLabelKey, string>;
      passwordLabel: string;
      passwordExpiredValue: string;
      test: string;
      connect: string;
      openAgentPc: string;
      openAgentBrowser: string;
      migration: string;
      noReads: string;
      selectHint: string;
      selectBody: string;
    };
    jobTest: (name: string) => string;
    jobConnect: (name: string) => string;
    steps: Record<ConnectionKind, string[]>;
    connectSteps: Record<ConnectionKind, string[]>;
    failedPc: (pc: string) => string;
    failedPassword: string;
    savePassword: string;
    failedAdvice: string;
    passwordAdvice: string;
    checkOk: (name: string, time: string) => string;
    checkLines: Record<ConnectionKind, string[]>;
    toastTested: (name: string) => string;
    toastConnected: (name: string) => string;
    toastFailed: (name: string) => string;
    toastFailedBody: string;
    log: {
      tested: (name: string) => string;
      connected: (name: string) => string;
      failed: (name: string, why: string) => string;
    };
  };
  /** p02: the agent on a PC, live. */
  agent: {
    root: string;
    keywords: string;
    registered: (n: string) => string;
    jobSteps: string[];
    tag: string;
    crumb: (pc: string) => string;
    live: Record<'live' | 'paused' | 'stopped' | 'done' | 'review', string>;
    takeOver: string;
    stop: string;
    stopConfirmTitle: (pc: string) => string;
    stopConfirmBody: string;
    stopConfirm: string;
    pause: string;
    resume: string;
    runStep: string;
    runAll: string;
    restart: string;
    nextInQueue: string;
    backToLive: string;
    reviewing: (time: string) => string;
    sections: { steps: string; checks: string; queue: string };
    now: string;
    ruleStop: string;
    ruleStopValue: string;
    rulePause: string;
    rulePauseValue: string;
    personAtPc: string;
    personAtPcOn: string;
    personAtPcOff: string;
    frameLabel: (time: string, label: string) => string;
    frameFuture: (label: string) => string;
    frames: string;
    banner: {
      paused: string;
      pausedPerson: string;
      pausedControl: string;
      stopped: string;
      done: (what: string) => string;
    };
    avgTime: string;
    jobStep: (label: string) => string;
    jobAll: string;
    toastDone: string;
    toastStopped: (pc: string) => string;
    toastResumed: string;
    toastPaused: string;
    log: {
      step: (pc: string, label: string) => string;
      done: (pc: string, what: string) => string;
      stopped: (pc: string) => string;
      paused: (pc: string, why: string) => string;
      resumed: (pc: string) => string;
      restarted: (pc: string) => string;
    };
    whyPerson: string;
    whyControl: string;
    whyManual: string;
  };
  /** p03: smart search. */
  search: {
    title: string;
    keywords: string;
    clearFacets: string;
    modes: { where: string; catalog: string };
    modesLabel: string;
    placeholderWhere: string;
    placeholderCatalog: string;
    suggestions: string;
    understood: string;
    facet: { sector: (v: string) => string; function: (v: string) => string; hook: (v: string) => string; region: (v: string) => string };
    results: (n: number) => string;
    emptyWhereTitle: (q: string) => string;
    emptyWhereBody: string;
    emptyCatalogTitle: string;
    emptyCatalogBody: string;
    emptyCatalogAction: string;
    where: {
      holdsIn: string;
      path: string;
      how: string;
      fetchExample: string;
      fetching: string;
      fetched: string;
      openProgram: string;
      jobTitle: (doc: string) => string;
      steps: Record<ConnectionKind, string[]>;
      toast: (doc: string) => string;
      log: (doc: string, program: string) => string;
    };
    catalog: {
      tags: { 'in-use': string; competitor: string };
      open: string;
      archive: string;
      archived: string;
      sourceLine: (label: string, date: string) => string;
      toastArchived: (name: string) => string;
      toastArchivedBody: string;
      log: (name: string) => string;
    };
    side: {
      tag: string;
      title: string;
      body: string;
      numbers: string;
      programs: string;
      officialMcp: string;
      api: string;
      robotOrAgent: string;
      collects: string;
      collectsBody: string;
      latest: string;
      todayShort: string;
    };
  };
  /** p04: competitors and migration. */
  migration: {
    root: string;
    keywords: string;
    currentHolds: string;
    currentCloud: string;
    picked: (alt: string, current: string) => string;
    pickedLines: { connection: string; cloud: string; effort: string };
    pickedConnection: (alt: string, current: string) => string;
    flowsUse: string;
    effortMonths: (n: number) => string;
    exportFile: (name: string) => string;
    views: { overview: string; connection: string; competitors: string; migration: string };
    viewsLabel: string;
    programLabel: string;
    heading: (name: string) => string;
    research: (date: string, sources: number) => string;
    redo: string;
    redoTitle: string;
    redoSteps: string[];
    redoToast: (name: string) => string;
    redoLog: (name: string) => string;
    columns: { program: string; connection: string; cloud: string; migration: string };
    current: string;
    noAlternatives: string;
    noAlternativesBody: string;
    matters: string;
    signals: string;
    signalsBody: string;
    advice: string;
    revisit: string;
    plan: string;
    planTotal: (months: number) => string;
    planNone: string;
    risks: string;
    risksNone: string;
    export: string;
    exportTitle: (name: string) => string;
    exportSteps: string[];
    exportReceipt: (file: string, at: string) => string;
    exportToast: string;
    exportLog: (name: string) => string;
    overviewTitle: string;
    overviewHint: string;
    overviewColumns: { program: string; advice: string; why: string; effort: string };
    openProgram: string;
    connectionNow: string;
    connectionCould: string;
    connectionCouldBody: string;
    connectionNoOthers: string;
    changeEffort: string;
    effortNone: string;
    matchesNow: string;
    estimateNote: string;
    peopleMatter: { pecPerMonth: string };
  };
  /** e01: where agents run. */
  agents: {
    root: string;
    keywords: string;
    add: string;
    place: {
      browser: { tag: string; title: string; description: string; state: string };
      pc: { tag: string; title: string; description: string };
      remote: { tag: string; title: string; description: string; state: string };
      stateLabel: string;
      activeOn: (n: number) => string;
      none: string;
    };
    columns: { computer: string; where: string; traits: string; does: string; state: string; lastSignal: string };
    pcState: Record<'working' | 'ready' | 'too-old' | 'updating' | 'pending' | 'removed', string>;
    filterTitle: (place: string) => string;
    filterClear: string;
    empty: string;
    side: {
      tag: string;
      title: string;
      body: string;
      requirements: string;
      windows: string;
      windowsValue: (v: number) => string;
      memory: string;
      memoryValue: (free: number, used: number) => string;
      network: string;
      networkValue: string;
      install: string;
      installValue: (mb: number) => string;
      rules: string;
      personAtPc: string;
      personAtPcValue: string;
      hours: string;
      hoursValue: string;
      session: string;
      sessionValue: string;
    };
    detail: {
      version: string;
      versionLatest: (v: string) => string;
      versionOld: (v: string, latest: string) => string;
      memory: string;
      memoryValue: (mb: number) => string;
      lastSignal: string;
      system: string;
      systemValue: (os: string, ram: number, year?: number) => string;
      programs: string;
      noProgramsValue: string;
      update: string;
      remove: string;
      reinstall: string;
      control: string;
      openAgent: string;
      none: string;
    };
    updateJob: (pc: string) => string;
    updateSteps: string[];
    updateToast: (pc: string, v: string) => string;
    updateLog: (pc: string, v: string) => string;
    removeTitle: (pc: string) => string;
    removeBody: string;
    removeConfirm: string;
    removeToast: (pc: string) => string;
    removeLog: (pc: string) => string;
    reinstallJob: (pc: string) => string;
    reinstallToast: (pc: string) => string;
    reinstallLog: (pc: string) => string;
    form: {
      title: string;
      body: string;
      name: string;
      namePlaceholder: string;
      office: string;
      system: string;
      systems: Array<{ value: string; label: string }>;
      submit: string;
      cancel: string;
      nameError: string;
      nameTaken: string;
      jobTitle: (name: string) => string;
      steps: string[];
      failedOld: string;
      toast: (name: string) => string;
      toastFailed: string;
      log: (name: string) => string;
      code: string;
      codeBody: string;
    };
  };
  /** e02: remote control with consent. */
  remote: {
    root: string;
    keywords: string;
    title: string;
    pcSide: string;
    topicsSide: string;
    desktopIdle: string;
    desktopEnded: string;
    dialog: {
      app: string;
      kind: string;
      title: string;
      body: (reason: string) => string;
      maxTime: string;
      maxTimeValue: (min: number) => string;
      recording: string;
      recordingValue: string;
      allow: string;
      deny: string;
    };
    whileLive: {
      banner: (who: string) => string;
      stop: string;
      remaining: (left: string) => string;
    };
    request: {
      title: string;
      body: string;
      pc: string;
      reason: string;
      submit: string;
      permission: string;
      reasonGeneric: string;
      consentGeneric: string;
    };
    asked: {
      title: (pc: string) => string;
      body: (who: string) => string;
      cancel: string;
    };
    live: {
      chip: string;
      consented: (who: string, time: string) => string;
      remaining: (left: string) => string;
      close: string;
      closeTitle: (pc: string) => string;
      closeBody: string;
      closeConfirm: string;
      keyboard: (who: string) => string;
      keyboardArmonia: string;
      keyboardPerson: string;
      passwordNote: string;
      save: string;
      saved: (time: string) => string;
      cancelMask: string;
    };
    denied: { title: (pc: string) => string; body: string; again: string; at: (time: string) => string };
    ended: {
      title: (pc: string) => string;
      body: (min: number) => string;
      how: Record<'closed' | 'person' | 'expired', string>;
      log: string;
      openLog: string;
      again: string;
      summary: { how: string; start: string; log: string };
    };
    who: { person: string; armonia: string };
    maskHalley: { title: string; user: string; password: string; expiry: string; expiryValue: string };
    toast: {
      asked: (pc: string) => string;
      askedBody: string;
      allowed: (pc: string) => string;
      denied: (pc: string) => string;
      ended: (pc: string) => string;
      endedBody: (min: number) => string;
      passwordSaved: string;
      passwordSavedBody: string;
      /** Saved when no run was stopped any more. */
      passwordSavedBodyNone: string;
      cancelled: string;
      passwordEmpty: string;
      nothingToCancel: string;
    };
    log: {
      cancelled: (pc: string) => string;
      asked: (pc: string) => string;
      allowed: (pc: string) => string;
      denied: (pc: string) => string;
      ended: (pc: string, min: number, how: string) => string;
      passwordSaved: (pc: string) => string;
      keyboard: (pc: string, who: string) => string;
    };
    notify: { askedTitle: (pc: string) => string; askedBody: string; endedTitle: (pc: string) => string };
    desktopWindows: Record<'teamsystem' | 'halley' | 'qgis' | 'desktop', string>;
  };
  /** The drawn windows of other programs (inert drawings). */
  masks: {
    explorer: string;
    qgisRows: Array<[string, string]>;
  };
}
