/**
 * Testing and governance: tests of a flow and of everything, permissions on the structure, team, sharing, people, the log.
 * The words of the `team` area of the preview; values in `i18n-ui-team-it.ts`
 * and `i18n-ui-team-en.ts`. Only product words: sector words arrive with the data.
 */

/** A count in a sentence. */
type Count = (n: number) => string;

/** The three fields a test compares between what the people decided and what the flow produced. */
export type TestField = 'kind' | 'office' | 'deadline';

export interface TeamCopy {
  /** Words used on more than one page. */
  common: {
    save: string;
    cancel: string;
    close: string;
    open: string;
    openCase: string;
    search: string;
    none: string;
    /** What an empty cell of a table shows. */
    blank: string;
    yes: string;
    no: string;
    today: string;
    now: string;
    estimate: string;
    example: string;
    by: (who: string) => string;
    at: (when: string) => string;
    ago: { minutes: Count; hours: Count; days: Count; justNow: string };
  };

  /** What the search finds in this area. */
  search: {
    groupPeople: string;
    groupConnections: string;
    groupSettings: string;
    log: string;
    logDetail: string;
    testAll: string;
    testAllDetail: string;
    structure: string;
    structureDetail: string;
    shares: string;
    sharesDetail: string;
    keywords: { person: string; role: string; connection: string; log: string; structure: string; shares: string; testAll: string };
  };

  /* ---------- c01: the test of one flow ---------- */
  test: {
    crumbTitle: (version: number) => string;
    viewsLabel: string;
    statusDay: (day: number, of: number) => string;
    statusActive: string;
    statusDraft: string;
    statusApproval: string;
    statusLive: (version: number) => string;
    run: string;
    runAgain: string;
    stages: { draft: string; cases: string; test: string; approval: string; live: string };
    stagesLabel: string;
    criteria: {
      title: string;
      agreedWith: (who: string) => string;
      columns: { criterion: string; required: string; now: string; state: string };
      rows: {
        tried: { label: string; detail: string };
        agree: { label: string; detail: string };
        critical: { label: string; detail: string };
        stable: { label: string; detail: string };
        hard: { label: string; detail: string };
        slow: { label: string; detail: string };
      };
      atLeast: (v: string) => string;
      under: (v: string) => string;
      exactly: (v: string) => string;
      outOf: (a: number, b: number) => string;
      states: { ok: string; near: string; bad: string; todo: string; unstable: Count; errors: Count; fails: Count };
      estimateNote: string;
    };
    cases: {
      title: string;
      count: (shown: number, total: number) => string;
      filterLabel: string;
      filters: { all: string; fail: string; pass: string };
      columns: { case: string; people: string; flow: string; outcome: string };
      pass: string;
      fail: string;
      unstable: string;
      resolved: string;
      fields: Record<TestField, string>;
      emptyTitle: string;
      emptyBody: string;
      noFlowCases: string;
      noMatch: string;
      showAll: string;
      viewingOlder: (when: string) => string;
      backToLast: string;
    };
    diff: {
      title: string;
      count: (diff: number, total: number) => string;
      columns: { case: string; flow: string; people: string; right: string };
      rounds: (r: string) => string;
      right: { pending: string; unstable: string; flowRight: string; personRight: string; ruleAdded: string };
      decide: string;
      decideItems: { flow: string; person: string; rule: string; open: string };
      emptyTitle: string;
      emptyBody: string;
      noRun: string;
    };
    job: {
      title: (name: string) => string;
      step: (caseTitle: string) => string;
      detail: (done: number, total: number) => string;
      done: (passed: number, total: number) => string;
      doneAllPass: (total: number) => string;
      failedTitle: string;
      failedBody: string;
      retry: string;
      toastTitle: (name: string) => string;
      toastBody: (passed: number, total: number) => string;
      noCases: string;
      openResults: string;
    };
    history: {
      title: string;
      empty: string;
      row: (passed: number, total: number) => string;
      by: (who: string) => string;
      night: string;
      version: (v: number) => string;
      current: string;
    };
    aside: {
      tag: string;
      title: string;
      body: string;
      fixedTitle: string;
      fixedAll: string;
      fixedFromCorrections: string;
      fixedWritten: string;
      fixedNote: string;
      unstableTitle: string;
      unstableBody: (kind: string, office: string) => string;
      unstableNone: string;
      addRule: string;
      ruleAdded: string;
      openCase: string;
      afterTitle: string;
      approves: string;
      nightly: string;
      nightlyValue: (n: number) => string;
      ifChanges: string;
      ifChangesValue: string;
    };
    gate: {
      title: string;
      days: (day: number, of: number) => string;
      daysDone: string;
      missing: (list: string) => string;
      notRun: string;
      ready: string;
      request: string;
      approve: string;
      requested: (who: string) => string;
      approveTitle: string;
      approveBody: (flow: string, version: number, early: number) => string;
      approveConfirm: string;
      approvedToast: (flow: string, version: number) => string;
      requestedToast: (flow: string, version: number) => string;
      wrongStage: string;
      liveLine: (version: number) => string;
      rule: (kind: string, office: string) => string;
      ruleToast: string;
      decidedToast: string;
      notifyRequestTitle: (flow: string, version: number) => string;
      notifyRequestBody: string;
    };
    log: {
      started: (flow: string, version: number) => string;
      finished: (flow: string, passed: number, total: number) => string;
      requested: (flow: string, version: number) => string;
      approved: (flow: string, version: number) => string;
      rule: (flow: string, rule: string) => string;
      decided: (caseTitle: string, who: string) => string;
      sideFlow: string;
      sidePerson: string;
    };
  };

  /* ---------- c02: the test of everything ---------- */
  testAll: {
    crumb: string;
    detail: string;
    filterLabel: string;
    filters: { all: string; testing: string; redo: string };
    kpi: {
      active: { label: string; detail: string };
      testing: { label: string; detail: string };
      stability: { label: string; detail: string };
      fixed: { label: string; detail: string };
    };
    columns: { what: string; kind: string; version: string; state: string; fixed: string; stability: string; last: string; approvedBy: string; actions: string };
    kinds: { flow: string; ai: string; rule: string; robot: string; data: string; procedure: string; system: string };
    states: { active: string; testing: string; redo: string; draft: string };
    last: { night: string; justNow: string; daysAgo: Count; minutes: Count; never: string };
    runOne: string;
    runningRow: string;
    runAll: string;
    running: string;
    runningTitle: string;
    runningStep: (name: string) => string;
    runningDetail: (done: number, total: number) => string;
    summaryTitle: string;
    summaryAllOk: (n: number) => string;
    summaryWithFails: (ok: number, fails: number) => string;
    failTitle: string;
    failWhy: (why: string) => string;
    failCases: (n: number, name: string) => string;
    /** A live flow with no fixed case: it runs, but nothing checks it after a change. */
    noCasesTitle: (name: string) => string;
    noCasesWhy: string;
    openTest: string;
    openConnection: string;
    noneTitle: string;
    noneBody: string;
    noMatchTitle: string;
    noMatchBody: string;
    rule: { title: string; body: string };
    toastTitle: string;
    toastBody: (ok: number, fails: number) => string;
    logFinished: (n: number, fails: number) => string;
    robotOffline: (name: string) => string;
    /** The connection is on again after a fault: the robot's test is to redo. */
    robotRetest: (name: string) => string;
    robotOk: (name: string) => string;
    statusFootnote: string;
    notTestedYet: string;
  };

  /* ---------- c03: who may change the structure ---------- */
  structure: {
    intro: string;
    rolesTitle: string;
    rolesBody: string;
    rolesLabel: string;
    partsTitle: string;
    partsBody: string;
    partsLabel: string;
    permissionColumn: string;
    permissionRows: Record<
      'view:flows' | 'view:data' | 'view:views' | 'view:channels' | 'view:programs' | 'view:knowledge' | 'edit:structure' | 'run:tests' | 'approve' | 'admin',
      { label: string; hint: string }
    >;
    columns: { part: string; sees: string; proposes: string; edits: string; approves: string };
    everyone: string;
    nobody: string;
    explain: { seeTitle: string; seeBody: string; proposeTitle: string; proposeBody: string; approveTitle: string; approveBody: string };
    proposals: {
      title: string;
      tag: string;
      empty: string;
      add: string;
      open: string;
      askedBy: (who: string, when: string) => string;
      stages: { proposta: string; modifica: string; collaudo: string; approvazione: string };
      whoDoes: string;
      edits: string;
      tests: string;
      approves: string;
      testsValue: string;
      dialogTitle: string;
      dialogTitleField: string;
      dialogReason: string;
      dialogFlow: string;
      dialogSubmit: string;
      sentToast: string;
      titleRequired: string;
      logAdded: (title: string) => string;
      notifyTitle: string;
      noFlow: string;
    };
    you: {
      title: (role: string) => string;
      canEdit: string;
      canPropose: string;
      canSee: string;
      cannotSee: string;
    };
    toggles: {
      logOn: (role: string, perm: string) => string;
      logOff: (role: string, perm: string) => string;
      toastOn: (role: string, perm: string) => string;
      toastOff: (role: string, perm: string) => string;
      selfTitle: string;
      selfBody: (perm: string) => string;
      selfConfirm: string;
      resetToRole: string;
      changed: string;
    };
    onlyAdmin: string;
  };

  /* ---------- t01: team and permissions on data ---------- */
  squad: {
    intro: string;
    invite: string;
    tabsLabel: string;
    tabs: { people: string; data: string; invites: string };
    search: string;
    roleFilter: string;
    allRoles: string;
    columns: { person: string; role: string; offices: string; orgs: string; actions: string };
    allOffices: string;
    edit: string;
    editTitle: (who: string) => string;
    roleField: string;
    officesField: string;
    officesHint: string;
    orgsField: string;
    saved: string;
    savedBody: string;
    logRole: (who: string, from: string, to: string) => string;
    logOffices: (who: string) => string;
    logOrgs: (who: string) => string;
    emptyTitle: string;
    emptyBody: string;
    clear: string;
    you: string;
    exampleTag: string;
    selfRoleTitle: string;
    selfRoleBody: string;
    selfRoleConfirm: string;
    pending: string;
    dataTitle: string;
    dataBody: string;
    dataLabel: string;
    dataRows: Record<
      'view:today' | 'view:inbox' | 'view:data' | 'view:knowledge' | 'view:views' | 'view:overview' | 'view:board' | 'view:callcenter' | 'edit:data' | 'export',
      { label: string; hint: string }
    >;
    everywhereTag: string;
    everywhereTitle: string;
    everywhereBody: string;
    recentTitle: string;
    recentEmpty: string;
    control: { title: string; beyond: string; beyondValue: string; review: string; reviewValue: string };
    roleCount: (n: number) => string;
    invites: {
      title: string;
      empty: string;
      emptyBody: string;
      columns: { email: string; role: string; orgs: string; sent: string; actions: string };
      resend: string;
      cancel: string;
      sending: string;
      sentToast: string;
      sentBody: (email: string) => string;
      resentToast: string;
      resentBody: (email: string) => string;
      cancelTitle: string;
      cancelBody: (email: string) => string;
      cancelConfirm: string;
      cancelledToast: string;
      dialogTitle: string;
      emailField: string;
      emailPlaceholder: string;
      emailInvalid: string;
      emailTaken: string;
      roleField: string;
      orgsField: string;
      send: string;
      jobTitle: (email: string) => string;
      jobStep: string;
      logSent: (email: string, role: string) => string;
      logResent: (email: string) => string;
      logCancelled: (email: string) => string;
      accessNote: string;
      receiptTitle: string;
      receipt: (email: string, role: string) => string;
    };
  };

  /* ---------- t02: sharing with an outside person ---------- */
  shares: {
    intro: string;
    newShare: string;
    filterLabel: string;
    filters: { active: string; expired: string; revoked: string; all: string };
    search: string;
    columns: { what: string; who: string; can: string; until: string; opens: string; state: string };
    can: { view: string; comment: string };
    scopeKind: { record: string; view: string };
    state: { active: string; expired: string; revoked: string };
    opensCount: (n: number) => string;
    neverOpened: string;
    emptyTitle: string;
    emptyBody: string;
    noMatchTitle: string;
    noMatchBody: string;
    detail: {
      tag: string;
      linkLabel: string;
      copy: string;
      copied: string;
      copiedBody: string;
      tryLink: string;
      tryLinkToast: (who: string) => string;
      revoke: string;
      revoked: string;
      open: string;
      scope: string;
      sees: string;
      canField: string;
      untilField: string;
      watermark: string;
      watermarkHint: string;
      codeNote: string;
      opensTitle: string;
      opensEmpty: string;
      accessCode: string;
      createdBy: (who: string, when: string) => string;
      untilInvalid: string;
    };
    includes: { record: string; contributor: string; sameContributor: string; assistant: string };
    dialog: {
      title: string;
      scopeKindField: string;
      targetField: string;
      emailField: string;
      emailPlaceholder: string;
      emailInvalid: string;
      guestField: string;
      canField: string;
      untilField: string;
      untilInvalid: string;
      seesField: string;
      watermark: string;
      submit: string;
      accessNote: string;
      targetRequired: string;
    };
    job: { title: (target: string) => string; steps: { link: string; code: string; mail: string } };
    receipt: { title: string; lines: (email: string, until: string) => string[] };
    created: string;
    createdBody: (email: string) => string;
    revokeTitle: string;
    revokeBody: (who: string) => string;
    revokeConfirm: string;
    revokedToast: string;
    log: {
      created: (what: string, who: string) => string;
      revoked: (what: string, who: string) => string;
      opened: (what: string, who: string) => string;
      changed: (what: string) => string;
    };
    notifyTitle: string;
    notifyBody: (what: string, who: string) => string;
    linkBase: string;
  };

  /* ---------- n16: people, roles, connections ---------- */
  connections: {
    intro: (m365: string) => string;
    invite: string;
    peopleTitle: string;
    peopleBody: string;
    peopleColumns: { person: string; office: string; role: string; sees: string };
    manage: string;
    allOffices: string;
    title: string;
    summary: (connected: number, problems: number, todo: number) => string;
    columns: { program: string; how: string; state: string; by: string; last: string };
    methods: { robot: string; agent: string; mcp: string; read: string; mail: string; official: string };
    states: { connected: string; error: string; todo: string; working: string };
    lastNever: string;
    rights: { read: string; readwrite: string; send: string };
    dataTitle: string;
    dataRows: { where: string; ai: string; log: string; anon: string; compliance: string };
    dataOpen: string;
    detail: {
      tag: string;
      how: string;
      by: string;
      last: string;
      rights: string;
      usedBy: string;
      usedByNone: string;
      problem: string;
      reconnect: string;
      disconnect: string;
      connect: string;
      openPrograms: string;
      close: string;
      emptyTitle: string;
      emptyBody: string;
    };
    job: { reconnect: (name: string) => string; connect: (name: string) => string; steps: { open: string; read: string; save: string } };
    failedTitle: string;
    failedBody: (name: string) => string;
    failedRetry: string;
    reconnectedToast: (name: string) => string;
    reconnectedBody: string;
    /** Halley reconnected: the runs it had stopped went on. */
    reconnectedResumed: string;
    failedToast: (name: string) => string;
    disconnectTitle: (name: string) => string;
    disconnectBody: (name: string, flows: string) => string;
    disconnectBodyNone: string;
    disconnectConfirm: string;
    disconnectedToast: (name: string) => string;
    log: { reconnected: (name: string) => string; connected: (name: string) => string; disconnected: (name: string) => string; failed: (name: string) => string };
    notifyTitle: (name: string) => string;
    notifyBody: string;
    receipt: (name: string) => string;
  };

  /* ---------- n15: the log that cannot be edited ---------- */
  log: {
    sealed: string;
    search: string;
    export: string;
    verify: string;
    filterLabel: string;
    filters: { all: string; people: string; ai: string; robot: string; structure: string; access: string };
    person: string;
    allPeople: string;
    day: string;
    allDays: string;
    today: string;
    yesterday: string;
    columns: { when: string; who: string; what: string; subject: string; detail: string; hash: string };
    actor: { ai: string; robot: string; access: string; system: string };
    kinds: { case: string; structure: string; permission: string; test: string; knowledge: string; access: string; setting: string; share: string };
    count: (shown: number, total: number) => string;
    emptyTitle: string;
    emptyBody: string;
    clear: string;
    footnote: string;
    chain: { title: string; ok: (n: number) => string; notChecked: string; checked: (when: string) => string; tip: string; last: string };
    verifyJob: { title: string; steps: { read: string; hash: string; compare: string } };
    verifiedToast: (n: number) => string;
    verifiedBody: string;
    exportToast: string;
    exportBody: (n: number, file: string) => string;
    exportColumns: { when: string; who: string; what: string; subject: string; detail: string; kind: string; hash: string };
    fileName: string;
    live: string;
    persona: (name: string) => string;
  };
}
