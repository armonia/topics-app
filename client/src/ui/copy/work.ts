/**
 * Where people work: my day, the queue, a record, an original with its summary, the full record sheet.
 * The words of the `work` area of the preview; values in `i18n-ui-work-it.ts`
 * and `i18n-ui-work-en.ts`. Only product words: sector words arrive with the data.
 */
/** Where a case is in its life (the same four words as the case seeds). */
export type WorkCaseStatus = 'da-confermare' | 'in-lavorazione' | 'in-attesa' | 'chiusa'; // allow-italian: status id of the data model, not copy

/** What the assistant of a record can be asked about; the catalogue lists the words that mean each. */
export type AssistantIntent = 'deadline' | 'documents' | 'who' | 'amount' | 'norms' | 'related' | 'status' | 'signature' | 'help';

/** The kinds of action that close a phase of a record. */
export type PrimaryKind = 'deposit' | 'send-pec' | 'pay' | 'order' | 'reply' | 'grant' | 'reject-invoice';

export interface WorkCopy {
  time: {
    minutes: (n: number) => string;
    hours: (n: number) => string;
    days: (n: number) => string;
    today: string;
    tomorrow: string;
    overdueBy: (n: number) => string;
    inDays: (n: number) => string;
    /** Sunday first. */
    weekdays: string[];
    months: string[];
  };
  inbox: {
    confirmedField: string;
    saveValue: string;
    editValue: (label: string) => string;
    valueUsed: (short: string) => string;
    correct: string;
    alwaysPerson: (reason: string) => string;
    confidence: (pct: number) => string;
    dueNow: string;
    originLine: (channel: string, time: string, counterpart: string, attachments: number) => string;
    dueOn: (day: string) => string;
    /** Under an urgent input's «due now»: the term it really has (label of the deadline, day). */
    dueNowNote: (label: string, day: string) => string;
    afterConfirm: (next: string[], dates: string[]) => string;
    rejectTitle: (title: string) => string;
    rejectBody: string;
    rejectConfirm: string;
    searchPlaceholder: string;
    officeFilter: string;
    allOffices: string;
    noMatchTitle: string;
    noMatchBody: string;
    clearFilters: string;
    emptyTitle: string;
    emptyBody: string;
    goToday: string;
    decidedBanner: (status: string) => string;
    notFoundTitle: string;
    notFoundBody: string;
    backToQueue: string;
    fieldNotFound: string;
    selectOne: string;
    deniedConfirm: string;
  };
  record: {
    assistantBusy: string;
    tabDraft: string;
    tabAssistant: string;
    byDate: (day: string) => string;
    dueShort: (day: string) => string;
    noDeadline: string;
    receiptButton: string;
    stepsOf: (flow: string) => string;
    statusOf: Record<WorkCaseStatus, string>;
    checklist: string;
    checklistProgress: (done: number, total: number) => string;
    suggestions: string[];
    receipts: string;
    improveJob: string;
    improveSteps: string[];
    improveProposal: string;
    jobSteps: Record<PrimaryKind, string[]>;
    assignTo: string;
    assignee: (name: string) => string;
    /** The same for the header button, with the short name of the office. */
    assigneeShort: (name: string) => string;
    alreadyAssigned: string;
    openSheet: string;
    bannerConfirm: string;
    bannerConfirmBody: string;
    /** Why a draft exists already while the record still waits. */
    bannerConfirmDraft: string;
    /** Title of the main button while the record waits: pressing it asks for the confirmation first. */
    primaryWaits: string;
    goConfirm: string;
    bannerClosed: string;
    bannerWaiting: string;
    jobRunning: (title: string, step: string, done: number, total: number) => string;
    jobFailed: (pending: number) => string;
    retry: string;
    confirmFirstTitle: string;
    confirmFirstBody: string;
    confirmFirstConfirm: string;
    receiptClose: string;
    paragraphLabel: string;
    paragraphPlaceholder: string;
    paragraphAdd: string;
    paragraphEmpty: string;
    norms: string;
    parcel: string;
    parcelDetail: (comune: string, foglio: string, particella: string, canale?: string) => string;
    sectionFields: string;
    sectionHistory: string;
    reopen: string;
    summaryMain: string;
    moreActions: string;
    notFoundTitle: string;
    notFoundBody: string;
    backToList: string;
    fieldsEmpty: string;
    historyEmpty: string;
  };
  today: {
    title: string;
    tasksLabel: string;
    nothingToday: string;
    nothingTodayBody: string;
    deadlines: string;
    allDeadlines: string;
    noDeadlines: string;
    agenda: string;
    recent: string;
    nothingRecent: string;
    doneYesterday: string;
    dueOn: (day: string) => string;
    workDetail: (current: string, next?: string) => string;
    work: string;
    queueOverdue: (n: number) => string;
    toDo: string;
    queueTitle: (n: number) => string;
    queueDetail: string;
    open: string;
    waitingDetail: (receipt?: string) => string;
    review: string;
    groupOverdue: string;
    groupToday: string;
    groupWeek: string;
    groupLater: string;
    morning: string;
    afternoon: string;
    evening: string;
    headline: (n: number, urgent: number) => string;
    headlineNone: string;
    agendaOpened: string;
  };
  sheet: {
    openWorkspace: string;
    ask: string;
    openIn: (program: string) => string;
    fields: string;
    colField: string;
    colValue: string;
    colSource: string;
    colConfidence: string;
    corrected: string;
    noFields: string;
    deadlines: string;
    noDeadlines: string;
    history: string;
    documents: string;
    noDocuments: string;
    related: string;
    noRelated: string;
    whereIsEach: string;
    assistantWord: string;
    flowWord: string;
    ruleWord: string;
    pending: string;
    pendingWho: (office: string) => string;
    term: string;
    noTerm: string;
    counterpartOf: (program: string) => string;
    protocolOf: (program: string) => string;
    notProtocolled: string;
    protocolDate: (day: string) => string;
    rollsOver: string;
    whoLabel: string;
    waitsForConfirm: string;
    waitsForConfirmBody: string;
    closed: string;
    nowOn: (office: string) => string;
    stepNow: (current: string, next?: string) => string;
    office: string;
    assignee: string;
    viewers: string;
    people: (n: number) => string;
  };
  doc: {
    notFound: string;
    notFoundBody: string;
    modes: string;
    onlySummary: string;
    sideBySide: string;
    onlyOriginal: string;
    downloadSigned: string;
    documents: string;
    summary: string;
    summaryCount: (sentences: number, sources: number) => string;
    noSummary: string;
    noSummaryBody: string;
    fields: string;
    noFields: string;
    colField: string;
    colValue: string;
    colSource: string;
    signedValid: (from?: string) => string;
  };
  assistant: {
    keywords: Record<AssistantIntent, string[]>;
    noDeadlines: string;
    deadlinesIntro: (n: number) => string;
    deadlineLine: (label: string, distance: string, rule: string, calc: string) => string;
    noSigned: string;
    signedIntro: (n: number) => string;
    documentsIntro: (n: number) => string;
    documentDetail: (detail: string) => string;
    noAmount: string;
    amountIs: (amount: string) => string;
    fieldValue: (value: string) => string;
    noNorms: string;
    normsIntro: (n: number) => string;
    noRelated: string;
    relatedIntro: (n: number) => string;
    statusLine: (current: string, next: string | undefined, status: string) => string;
    whoLine: (counterpart: string, place?: string) => string;
    overview: (title: string, subject: string) => string;
    canAnswer: string;
  };
  events: {
    confirmed: string;
    notForUs: string;
    reopened: string;
    valueSet: (label: string, value: string) => string;
    assigned: (name: string) => string;
    draftSaved: (file: string) => string;
    receipt: (title: string) => string;
  };
  log: {
    confirmed: (record: string) => string;
    closed: (record: string) => string;
    reopened: (record: string) => string;
    valueSet: (record: string, label: string, value: string) => string;
    assigned: (record: string, name: string) => string;
    proposalAccepted: (record: string) => string;
    proposalDiscarded: (record: string) => string;
    paragraphAdded: (record: string) => string;
    draftSaved: (record: string) => string;
    improved: (record: string) => string;
    actionFailed: (record: string, action: string) => string;
    actionDone: (record: string, action: string) => string;
  };
  toast: {
    confirmed: (record: string) => string;
    openRecord: string;
    closed: (record: string) => string;
    closedBody: string;
    reopened: (record: string) => string;
    valueSet: (label: string) => string;
    assigned: (name: string) => string;
    proposalAccepted: string;
    proposalDiscarded: string;
    draftSaved: string;
    downloaded: (name: string) => string;
    improved: string;
    actionFailed: (action: string) => string;
    actionFailedBody: (pending: number) => string;
    openReceipt: string;
    paragraphAdded: string;
  };
  notify: {
    assigned: (record: string) => string;
  };
  search: {
    cases: string;
    documents: string;
  };
}
