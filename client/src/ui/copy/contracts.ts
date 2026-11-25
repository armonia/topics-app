/**
 * Contracts: the list, a contract with its clauses, versions and compare, comments, obligations, attachments, variations, signatures. (allow-italian: quotes the Italian interface)
 * Values in `i18n-ui-contracts-it.ts` and `i18n-ui-contracts-en.ts`; only product words,
 * the words of ORBIT's work arrive with the data.
 */
export interface ContractsCopy {
  title: string;
  common: {
    /** A clause by its printed number: `art. 9`. */
    clause: (n: string) => string;
    /** A version: `v3`. */
    version: (n: number) => string;
    euro: (amount: string) => string;
    perYear: string;
    vatExcluded: string;
    today: string;
    inDays: (n: number) => string;
    daysAgo: (n: number) => string;
    /** A long span, past two months: «5 mesi», «3 anni e 5 mesi». (allow-italian: quotes the Italian interface) */
    span: (years: number, months: number) => string;
    /** A long span ahead: «tra 3 anni e 5 mesi». (allow-italian: quotes the Italian interface) */
    inSpan: (span: string) => string;
    /** A long span behind: «1 anno e 8 mesi fa». (allow-italian: quotes the Italian interface) */
    spanAgo: (span: string) => string;
    cancel: string;
    readOnly: (role: string) => string;
    /** Kinds of an obligation, by the data code they map to. */
    obligationKinds: { deadline: string; recurring: string; penalty: string; renewal: string; report: string; guarantee: string };
    /** States of a variation. */
    variantStates: { running: string; approved: string; signed: string; rejected: string };
    /** Kinds of an attachment. */
    attachmentKinds: { signed: string; attachment: string; variant: string; minutes: string; guarantee: string };
    /** Relations inside a contract's family. */
    relations: { parent: string; subcontract: (clause: string) => string; staff: string; agreement: string; variant: (v: string) => string; self: string };
    /** What the person at a chain step is doing now, for the card they hold. */
    doing: { draft: string; review: string; approve: string; sign: string; countersign: string; fix: string; signed: (v: string) => string };
  };
  list: {
    subtitle: (n: number) => string;
    deadlines: string;
    tiles: {
      active: string;
      activeDetail: (all: number) => string;
      value: string;
      /** The total in millions, short enough for a tile: «176,9 mln €». (allow-italian: quotes the Italian interface) */
      valueText: (millions: string) => string;
      valueDetail: (yearly: string) => string;
      alerts: string;
      alertsDetail: (urgent: number) => string;
    };
    /** The names of the saved filters and of the values of the field «situation». */
    views: { all: string; expiring: string; late: string; variants: string; expired: string };
    /** The fields of the filter bar. */
    fields: { kind: string; status: string; team: string; counterparty: string; end: string; notice: string; situation: string };
    columns: { kind: string; title: string; counterparty: string; status: string; value: string; start: string; end: string; notice: string; renewal: string; alerts: string };
    noEnd: string;
    /** Under the end of a contract, the day it started: «dal 01/04/2026». (allow-italian: quotes the Italian interface) */
    since: (date: string) => string;
    noNotice: string;
    renewal: { tacit: (months: number) => string; option: (months: number) => string; none: string };
    noticeDetail: { tacit: (rel: string) => string; option: (rel: string) => string };
    emptyTitle: string;
    emptyBody: string;
    noAlerts: string;
    alertsAria: (n: number) => string;
  };
  deadlines: {
    crumb: string;
    title: string;
    viewsLabel: string;
    views: { list: string; calendar: string };
    /** The fields of the filter bar and its saved filters. */
    fields: { kind: string; contract: string; state: string; day: string };
    saved: { late: string; soon: string; notices: string };
    kinds: { all: string; end: string; notice: string; reminder: string; obligation: string };
    showDone: string;
    leadsLabel: string;
    lead: (days: number) => string;
    leadsHint: string;
    events: {
      end: string;
      notice: { tacit: string; option: string };
      reminder: (days: number, tacit: boolean) => string;
    };
    columns: { day: string; what: string; contract: string; clause: string; owner: string; status: string };
    status: { late: string; soon: string; open: string; done: string };
    clearDay: string;
    nothingThatDay: string;
    emptyTitle: string;
    emptyBody: string;
  };
  page: {
    facts: { counterparty: string; value: string; valueChanged: (v: string) => string; start: string; end: string; cig: string; noCig: string; owner: string; renewal: string; notice: string };
    family: string;
    /** The accessible name of the strip with the pages of a contract. */
    pagesLabel: string;
    alertsLabel: string;
    noAlerts: string;
    actions: {
      compare: (from: number, to: number) => string;
      compareNone: string;
      compareNoneTitle: string;
      compareHereTitle: string;
      newVariant: string;
    };
    variantDenied: { running: (v: number) => string; notInForce: string; expired: string; permission: string };
    textLabel: string;
    versionPicker: string;
    stamp: {
      inForce: (date: string) => string;
      superseded: (date: string, v: number) => string;
      locked: string;
      draft: string;
    };
    clauseHeading: (n: string, title: string) => string;
    commentsOf: (n: string, count: number, open: number) => string;
    obligationsOf: (n: string, count: number) => string;
    badges: { changedIn: (v: number, reason: string) => string; changesInDraft: (v: number) => string };
    quoteMissing: (v: number) => string;
    showVersion: (v: number) => string;
    paperBy: (who: string, date: string) => string;
    notFoundTitle: string;
    notFoundBody: string;
    back: string;
    /** The way back from a page of one contract (versions, compare, signatures, an attachment) to the contract. */
    backToContract: string;
  };
  side: {
    label: string;
    /** The strip under the head of a contract: its seven pages. */
    tabs: { text: string; obligations: string; comments: string; versions: string; attachments: string; signatures: string; links: string };
    /** The panel of the text page when a clause is on show: what is attached to it. */
    clauseTitle: (n: string) => string;
    obligations: {
      due: (date: string, rel: string) => string;
      noDate: string;
      done: string;
      doneBy: (who: string, date: string, proof: string) => string;
      doneNoProof: string;
      highlight: string;
      close: string;
      closeWithProof: string;
      proofLabel: string;
      proofPlaceholder: string;
      proofNeeded: string;
      closeDenied: (owner: string) => string;
      card: (id: string, stage: string) => string;
      empty: string;
      emptyClause: (clause: string) => string;
    };
    comments: {
      internal: string;
      add: string;
      clauseField: string;
      placeholder: string;
      send: string;
      reply: string;
      replyPlaceholder: string;
      sendReply: string;
      resolve: string;
      resolved: string;
      showResolved: (n: number) => string;
      changedSince: (v: number) => string;
      onDraft: (v: number) => string;
      empty: string;
      emptyClause: (clause: string) => string;
    };
    versions: {
      compareToggle: string;
      compareHint: string;
      openCompare: (a: number, b: number) => string;
      pickTwo: string;
      pick: (n: number) => string;
      show: string;
      onShow: string;
      inForce: string;
      signedSeal: string;
      draft: string;
      toApprove: string;
      origin: { first: string; variant: string; signed: string; agent: string; edited: string };
      value: (amount: string, share: string) => string;
      draftedBy: (agent: string) => string;
    };
    attachments: { empty: string; detail: (version: string, date: string) => string };
    links: { flows: string; cards: string; empty: string; flowDetail: (steps: number, perMonth: number) => string; flowStates: { live: string; testing: string; draft: string } };
  };
  compare: {
    crumb: string;
    title: (a: number, b: number) => string;
    from: string;
    to: string;
    swap: string;
    onlyChanged: string;
    counter: (i: number, n: number) => string;
    none: string;
    previous: string;
    next: string;
    summary: (changed: number, added: number, removed: number) => string;
    /** The name of the row of changed clauses that jump to each difference. */
    jumpLabel: string;
    /** One changed clause in that row, with what happened to it: «art. 9». (allow-italian: quotes the Italian interface) */
    jumpTo: (clause: string, status: string) => string;
    value: (from: string, to: string, share: string) => string;
    valueSame: string;
    threshold: { under: string; over: string };
    status: { same: string; changed: string; added: string; removed: string };
    notThere: string;
    sameVersion: string;
    legend: { removed: string; added: string };
    waiting: (who: string, action: string) => string;
    openSignatures: string;
    columnLabel: (v: number, state: string) => string;
    versionState: { signed: string; draft: string; inForce: string };
  };
  attachment: {
    crumb: string;
    version: (n: number) => string;
    signatureTitle: string;
    signedBy: (who: string, party: string, at: string) => string;
    register: (n: string) => string;
    hash: string;
    others: string;
    notFoundTitle: string;
    notFoundBody: string;
    signedCopy: (v: number) => string;
    signedLines: { contract: (title: string) => string; counterparty: (name: string) => string; value: (amount: string) => string; clauses: (n: number) => string };
  };
  signatures: {
    crumb: string;
    chainTitle: (v: number) => string;
    locked: string;
    states: { done: string; waiting: string; todo: string; changes: string };
    why: { draft: string; review: string; approve: string; sign: string; countersign: string };
    actions: {
      approve: string;
      draft: string;
      sign: string;
      countersign: string;
      requestChanges: string;
      sendBack: string;
      note: string;
      notePlaceholder: string;
      changesPlaceholder: string;
      running: string;
    };
    denied: { notYou: (who: string) => string; approve: string; sign: string; edit: string; needNote: string };
    request: (who: string, date: string, note: string) => string;
    matrixTitle: string;
    matrixHint: string;
    matrix: { team: string; people: string; level: string; can: string; chain: string; exception: string; openPermissions: string; approve: string; sign: string; without: (what: string) => string };
    you: string;
    auditTitle: string;
    auditEmpty: string;
    audit: { step: (action: string, who: string) => string; request: (who: string) => string; signed: (v: number, register: string) => string };
    job: {
      signTitle: (v: number) => string;
      certificate: string;
      hash: string;
      sign: string;
      timestamp: string;
      countersignTitle: string;
      pec: (to: string) => string;
      delivery: string;
      countersigned: string;
    };
    receipt: {
      signTitle: string;
      countersignTitle: string;
      at: (date: string) => string;
      document: (title: string, v: number) => string;
      signer: (name: string) => string;
      hash: (h: string) => string;
      register: (n: string) => string;
      pec: (to: string) => string;
      delivery: (n: string) => string;
      countersigned: (date: string) => string;
      openCopy: string;
    };
  };
  variant: {
    title: (contract: string) => string;
    intro: string;
    reason: string;
    reasonPlaceholder: string;
    reasonHint: string;
    clauses: string;
    clausesHint: string;
    valueClauseHint: string;
    valueMode: string;
    modes: { same: string; amount: string; share: string };
    amount: string;
    amountHint: string;
    share: string;
    shareHint: string;
    preview: (value: string, share: string) => string;
    unchanged: (value: string) => string;
    create: string;
    needReason: string;
    needClause: string;
    needValue: string;
    draftNote: (reason: string) => string;
    newAmount: (amount: string) => string;
    versionReason: (reason: string) => string;
    chain: { draft: string; review: string; approve: (share: string) => string; overThreshold: string; countersignPublic: string; countersignPrivate: string };
    card: {
      title: (reason: string) => string;
      detail: (place: string, v: number, share: string) => string;
      doing: string;
      proposal: (v: number, from: number) => string;
      original: string;
      originalFrom: string;
      lines: { contract: (title: string) => string; reason: (r: string) => string; clauses: (list: string) => string; value: (v: string) => string; valueSame: string; by: (who: string, at: string) => string };
      values: { reason: string; clauses: string; value: string };
    };
  };
  log: {
    approved: (action: string, v: number, contract: string) => string;
    changes: (contract: string, note: string) => string;
    signed: (v: number, contract: string, register: string) => string;
    countersigned: (contract: string, to: string) => string;
    obligation: (what: string, contract: string) => string;
    comment: (clause: string, contract: string) => string;
    reply: (clause: string, contract: string) => string;
    resolved: (clause: string, contract: string) => string;
    variant: (v: number, contract: string, card: string) => string;
  };
  toast: {
    approved: (action: string) => string;
    approvedBody: (next: string) => string;
    complete: string;
    changes: (who: string) => string;
    signed: (v: number) => string;
    countersigned: string;
    obligation: string;
    comment: string;
    reply: string;
    resolved: string;
    variant: (v: number, card: string) => string;
    variantBody: string;
    openCard: string;
  };
  notify: {
    yourTurn: (action: string, contract: string) => string;
    changes: (contract: string) => string;
    signed: (contract: string, v: number) => string;
    variant: (contract: string) => string;
  };
  search: {
    contracts: string;
    clauses: string;
    deadlines: string;
    deadlinesDetail: string;
  };
}
