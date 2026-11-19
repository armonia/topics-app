/**
 * SARIM edition: «Dati» (tables, rows, deadlines) and «Conoscenza» (documents, procedures, laws). (allow-italian: quotes the Italian interface)
 * Values in `i18n-ui-sarim-data-it.ts` and `i18n-ui-sarim-data-en.ts`; only product words,
 * the words of SARIM's work arrive with the data.
 */

/** A table of «Dati», by address segment: the ones the world lists, then `contratti` and `comuni`. (allow-italian: quotes the Italian interface) */
export type SarimTableWord = string;
export type SarimDataViewWord = 'table' | 'board' | 'chart';
export type SarimDeadlineKind = 'card' | 'end' | 'notice' | 'obligation';
export type SarimDeadlineState = 'late' | 'soon' | 'open' | 'done';
/** The id of a saved filter that ships with a table: the ones the world lists in `dataViews`, `noticeSoon` and `pastTowns`. */
export type SarimBuiltInView = string;
export type SarimKnowledgeCollectionWord = 'norme' | 'azienda' | 'procedure'; // allow-italian: address segments, compared by value
export type SarimUsageWord = 'cards' | 'flows' | 'contracts' | 'procedures';

export interface SarimDataCopy {
  title: string;

  /** The strip under the header of «Conoscenza»: its four sections. (allow-italian: quotes the Italian interface) */
  section: { label: string; documents: string; contracts: string; data: string; rules: string };

  common: {
    open: string;
    blank: string;
    yes: string;
    no: string;
    cards: (n: number) => string;
    openCards: (n: number) => string;
    contracts: (n: number) => string;
    rows: (n: number) => string;
    euro: (amount: string) => string;
    since: (age: string) => string;
    clause: (n: number | string) => string;
    /** Where a check applies: the flow, by its short name, and the number of its step. */
    step: (flow: string, n: number) => string;
    /** A step of a flow by its number, as «Flussi» names it. (allow-italian: quotes the Italian interface) */
    stepNumber: (n: number) => string;
    external: { title: (host: string) => string; body: (url: string) => string; confirm: string };
    searchGroups: { tables: string; towns: string; documents: string; parts: string; procedures: string };
  };

  tables: Record<SarimTableWord, { label: string; about: string }>;

  nav: {
    deadlines: string;
    kanban: string;
    contracts: string;
    knowledge: string;
    overview: string;
    cardsHint: (rows: number, open: number) => string;
    rowsHint: (rows: number) => string;
    viewHint: (rows: number, table: string) => string;
  };

  overview: {
    fields: { kind: string; stopped: string };
    kinds: Record<'cards' | 'contracts' | 'towns', string>;
    empty: { title: string; body: string };
    stats: {
      open: string;
      openDetail: string;
      stopped: string;
      stoppedDetail: string;
      contracts: string;
      contractsDetail: (notices: number) => string;
      deadlines: string;
      deadlinesDetail: (cards: number, contracts: number) => string;
    };
    tableLabel: string;
    columns: { table: string; rows: string; open: string; stopped: string; about: string };
  };

  columns: {
    code: string;
    /** The name of a value read on an original (address, user code). */
    field: string;
    title: string;
    stage: string;
    worker: string;
    doing: string;
    reviewer: string;
    place: string;
    due: string;
    since: string;
    priority: string;
    stopped: string;
    flow: string;
    proposal: string;
    contract: string;
    kind: string;
    counterparty: string;
    value: string;
    start: string;
    end: string;
    notice: string;
    status: string;
    version: string;
    owner: string;
    area: string;
    cig: string;
    alerts: string;
    next: string;
    town: string;
    province: string;
    service: string;
    from: string;
    state: string;
    contracts: string;
    cards: string;
    source: string;
  };

  values: {
    priority: Record<'alta' | 'normale' | 'bassa', string>; // allow-italian: data codes, compared by value
    period: Record<'anno' | 'totale' | 'mese', string>; // allow-italian: data codes, compared by value
    stoppedBecause: (age: string, reason: string) => string;
    stuck: (age: string) => string;
    stuckShort: string;
    notStopped: string;
    agent: string;
    noEnd: string;
    noNotice: string;
    version: (n: number) => string;
    versionOpen: (current: number, latest: number) => string;
    alerts: (n: number) => string;
    townActive: string;
    townPast: string;
  };

  views: {
    builtIn: Record<SarimBuiltInView, string>;
  };

  table: {
    views: Record<SarimDataViewWord, string>;
    viewsLabel: string;
    groupLabel: string;
    columnsButton: string;
    columnsTitle: string;
    columnsReset: string;
    exportCsv: string;
    openKanban: string;
    openStages: string;
    openContracts: string;
    searchPlaceholder: (table: string) => string;
    footer: (shown: number, total: number) => string;
    notFound: { title: string; body: string; back: string };
    selection: { label: string; count: (n: number) => string; assign: string; assignDenied: string; export: string; clear: string };
    assignDoing: string;
    assigned: (n: number, who: string) => string;
    logAssigned: (id: string, who: string) => string;
    exported: (n: number) => string;
    logExported: (n: number, table: string) => string;
    file: (table: string, day: string) => string;
  };

  peek: {
    openRow: string;
    card: string;
    contract: (clause: string) => string;
    versions: string;
    clauses: string;
    town: string;
    source: string;
    contractCards: string;
  };

  row: {
    back: (table: string) => string;
    previous: string;
    next: string;
    position: (n: number, total: number) => string;
    openCard: string;
    openKanban: string;
    openStages: string;
    openContract: string;
    openVersions: string;
    openSource: string;
    sections: {
      facts: string;
      values: string;
      proposal: string;
      history: string;
      originals: string;
      obligations: string;
      alerts: string;
      versions: string;
      cards: string;
      contracts: string;
      deadlines: string;
      cited: string;
    };
    confidence: (n: number) => string;
    readFrom: (doc: string) => string;
    entered: (stage: string, who: string) => string;
    obligationDone: string;
    noCards: string;
    noContracts: string;
    noDeadlines: string;
    noObligations: string;
    noAlerts: string;
    noCited: string;
    versionSigned: string;
    versionOpen: string;
    notFound: { title: string; body: string; back: string };
  };

  deadlines: {
    title: string;
    kinds: Record<'all' | SarimDeadlineKind, string>;
    fields: { kind: string; area: string; state: string; within: string; day: string };
    saved: { late: string; soon: string; notices: string; week: string };
    showDone: string;
    view: { label: string; list: string; calendar: string };
    states: Record<SarimDeadlineState, string>;
    what: { end: string; noticeTacit: string; noticeOption: string };
    columns: { day: string; what: string; about: string; area: string; owner: string; status: string };
    empty: { title: string; body: string; clear: string };
    tag: Record<SarimDeadlineKind, string>;
    exportCsv: string;
    exported: (n: number) => string;
    logExported: (n: number) => string;
    file: (day: string) => string;
    nothing: string;
  };

  knowledge: {
    title: string;
    collections: Record<SarimKnowledgeCollectionWord, string>;
    home: {
      recent: string;
      recentEmpty: string;
      asked: (when: string) => string;
      cited: string;
      citedCount: (n: number) => string;
      documentsLabel: string;
      rulesLabel: string;
      columns: { doc: string; rule: string; issuer: string; status: string; updated: string; cited: string };
      docCount: (n: number) => string;
      ruleCount: (n: number) => string;
      drafts: (n: number) => string;
      parts: (n: number) => string;
    };
    /** The lists of documents and of rules: the fields of the filter bar, the saved filters, the empty list. */
    list: {
      fields: { type: string; issuer: string; flow: string; state: string; updated: string };
      types: Record<'law' | 'procedure' | 'company', string>;
      states: Record<'draft' | 'current', string>;
      saved: { draft: string; law: string; procedure: string };
      empty: { title: string; body: string };
      emptyRules: { title: string; body: string };
    };
    ask: { placeholder: string; placeholderPhone: string; placeholderDoc: (doc: string) => string; empty: string; shared: string; log: (question: string) => string; noUsage: string; noSourceBody: (question: string) => string };
    doc: {
      notFound: { title: string; body: string; back: string };
      /** The strip under the title: three places of one document. */
      pages: { label: string; text: string; versions: string; usage: string };
      panelTitle: string;
      panelTitleProcedure: string;
      facts: string;
      issuer: string;
      official: string;
      quotesFrom: string;
      checks: string;
      parts: string;
      cited: (n: number) => string;
      quoteTag: string;
      summaryTag: string;
      rests: string;
      checksInline: string;
      officialButton: string;
      officialPart: string;
      usage: Record<SarimUsageWord, string>;
      usageCard: (stage: string, why: string) => string;
      usageFlow: (step: string, why: string) => string;
      usageClause: (clause: string, why: string) => string;
      usageStep: (step: string) => string;
      procedure: {
        tag: string;
        writtenBy: string;
        writtenAt: string;
        state: string;
        approver: string;
        approvedAt: string;
        flows: string;
        programs: string;
        time: string;
        basedOn: string;
        mistakes: string;
        draft: string;
        approved: string;
        approvedBy: (who: string) => string;
        draftNote: (agent: string, who: string) => string;
        changesAsked: string;
      };
    };
    approve: {
      button: string;
      onlyApprover: (who: string) => string;
      title: (label: string) => string;
      body: (flows: string) => string;
      confirm: string;
      toast: string;
      log: (label: string, version: string) => string;
      notifyTitle: (label: string) => string;
      notifyBody: (who: string) => string;
    };
    changes: {
      button: string;
      buttonApproved: string;
      title: (label: string) => string;
      label: string;
      placeholder: string;
      required: string;
      hint: string;
      send: string;
      cancel: string;
      job: (label: string) => string;
      steps: { reading: string; writing: string; checking: string };
      toast: string;
      log: (label: string, note: string) => string;
      versionLabel: (n: number) => string;
      versionDetail: (agent: string, note: string) => string;
      running: string;
      notifyTitle: (label: string) => string;
    };
    versions: { toApprove: string; approved: string; replaced: string };
  };
}
