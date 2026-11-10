/**
 * «Da fare»: the list of cards by flow, the kanban, the table per stage, the card with its originals. (allow-italian: quotes the Italian interface)
 * Values in `i18n-ui-kanban-it.ts` and `i18n-ui-kanban-en.ts`; only product words,
 * the words of SARIM's work arrive with the data. Names follow the glossary
 * (`brief/glossario-sarim.md`). (allow-italian: names the glossary terms)
 */
export interface KanbanCopy {
  title: string;
  /** The title of the cards of one flow kept beside an open card. */
  titleIn: (flow: string) => string;
  views: { label: string; list: string; kanban: string; stages: string };
  /** The words of the filter bar of «Da fare» (allow-italian: quotes the Italian interface): its fields, their values and the saved filters. */
  filters: {
    fields: {
      card: string;
      flow: string;
      stage: string;
      who: string;
      reviewer: string;
      due: string;
      priority: string;
      stuck: string;
      town: string;
      number: string;
      contract: string;
      /** The yes/no field behind the saved filter of the cards an agent holds. */
      inHand: string;
    };
    /** The value that stands for every agent at once. */
    anyAgent: string;
    yes: string;
    no: string;
    priorities: { alta: string; normale: string; bassa: string };
    saved: { waiting: string; dueSoon: string; stuck: string; agents: string };
  };
  empty: { title: string; body: string; clear: string };
  /** Why a move is off for a person who only sees a flow. */
  access: {
    sectionView: string;
    flowView: (flow: string) => string;
  };
  board: {
    label: string;
    empty: string;
    drop: string;
    moveTo: string;
    moveItem: (stage: string) => string;
    piles: string;
    cards: (n: number) => string;
    /** A folded column: what opening it shows. */
    open: (stage: string, n: number) => string;
    /** The pill at the right edge of the board: the next column hidden by the scroll, and a way to bring it in. */
    more: (stage: string, n: number) => string;
  };
  card: {
    high: string;
    low: string;
    priority: (p: string) => string;
    today: string;
    tomorrow: string;
    overdue: (day: string) => string;
    due: (day: string) => string;
    blockedTitle: (reason: string, since: string) => string;
    stuck: (time: string) => string;
    stuckTitle: (stage: string, limit: string) => string;
    since: (time: string) => string;
    /** Instead of «da 0 min». (allow-italian: quotes the Italian interface) */
    justNow: string;
    reviewer: (name: string) => string;
    /** The same line on a card waiting for approval. */
    approver: (name: string) => string;
    agentAtWork: string;
    open: (id: string) => string;
    /** The accessible name of a card on the kanban: its id and its title. */
    openNamed: (id: string, title: string) => string;
    flow: string;
    step: string;
  };
  /** «Per stato» (allow-italian: quotes the Italian interface): flows against stages. */
  stages: {
    label: string;
    flowColumn: string;
    stuckColumn: string;
    closedColumn: string;
    count: (n: number) => string;
    wait: (time: string) => string;
    stuck: (n: number) => string;
    piles: string;
    pilesWhy: (n: number, stage: string) => string;
    pilesTie: (n: number, stage: string, time: string) => string;
    allFlows: string;
    allFlowsSub: (n: number) => string;
    flowSub: (agent: string, limit: string) => string;
    /** The accessible name of a cell: shows these cards in the list. */
    cell: (flow: string, stage: string, n: number, stuck: number) => string;
    openFlow: (flow: string) => string;
    openStuck: (flow: string, n: number) => string;
    agents: (n: number) => string;
    persons: (n: number) => string;
    shareNone: string;
    shareTip: string;
  };
  list: {
    label: string;
    columns: { card: string; stage: string; worker: string; due: string; stuckSince: string };
    /** The accessible name of a group header: the flow and what pressing does. */
    toggle: (flow: string, open: boolean) => string;
    cards: (n: number) => string;
    stuck: (n: number) => string;
    waiting: (n: number) => string;
    /** An empty cell (no due day, no time in a stage because the card is closed): one dash, in every table. */
    none: string;
  };
  detail: {
    /** The tip of the worker token: how long and since when. */
    sinceAt: (time: string, at: string) => string;
    justNowAt: (at: string) => string;
    justEntered: string;
    reviewer: string;
    /** After the name of the person who holds the card and also checks it: one row, not two. */
    workAndCheck: string;
    /** «Passo 3 di 7: …» in the line above the title. (allow-italian: quotes the Italian interface) */
    stepPosition: (n: number, total: number, title: string) => string;
    /** The button of the line above the title that reads the flow beside the card. */
    openFlow: string;
    openFlowTip: (flow: string) => string;
    contract: string;
    signatures: string;
    clause: (n: string) => string;
    linkedCard: (id: string) => string;
    /** The due day and how far it is: «08/11 · tra 2 g», «05/11 · in ritardo di 3 g». (allow-italian: quotes the Italian interface) */
    dueDay: (day: string, days: number) => string;
    /** The box of what happens next, and the same box on a closed card. */
    next: string;
    closed: string;
    confidence: (n: number) => string;
    lowConfidence: string;
    /** The section of the original beside the values read from it. */
    originalSection: string;
    valuesHint: string;
    valuesCount: (n: number) => string;
    originalPick: string;
    openOriginal: string;
    noValues: string;
    history: string;
    eventsCount: (n: number) => string;
    stayed: (time: string) => string;
    stillThere: (time: string) => string;
    movedBy: (who: string) => string;
    /** The first stage of the history: the card came in, it was not moved. */
    arrivedBy: (who: string) => string;
    /** A person took the card in hand without moving it. */
    tookOver: (who: string) => string;
    stopped: string;
    /** The section with the chat about the card. */
    chat: string;
    /** The panel that reads the flow of the card beside it. */
    flowPanel: {
      label: (flow: string) => string;
      close: string;
      here: string;
      doneBy: (who: string, day: string, time: string) => string;
      openFull: string;
    };
    notFound: string;
    notFoundBody: (id: string) => string;
    back: string;
  };
  actions: {
    label: string;
    take: string;
    takeMine: string;
    forward: string;
    forwardTo: (stage: string) => string;
    forwardHint: (stage: string) => string;
    sendBack: string;
    sendBackAgent: (agent: string) => string;
    /** Why «Avanti» is off on a card that is stopped. */
    forwardWaits: string;
    approve: string;
    approveInContract: string;
    approveHint: string;
    /** A card of the contract variations flow: the approval opens in its contract. */
    approveInContractHint: string;
    closed: string;
    closeNeeds: (name: string) => string;
    takenDoing: string;
    sentBackDoing: string;
    closedDoing: string;
    logMoved: (id: string, title: string, stage: string) => string;
    toastMoved: (stage: string) => string;
    logTaken: (id: string, title: string) => string;
    toastTaken: string;
    logSentBack: (id: string, title: string, agent: string) => string;
    toastSentBack: (agent: string) => string;
    logApproved: (id: string, title: string) => string;
    toastApproved: string;
    logValue: (id: string, label: string, value: string) => string;
    toastValue: (label: string) => string;
    openCard: string;
    gateTitle: string;
    gateBody: (id: string, contract: string, version: number) => string;
    gateConfirm: string;
    logGate: (id: string, contract: string) => string;
  };
  original: {
    values: string;
    valuesHint: string;
    none: string;
    others: string;
    photo: string;
    notFound: string;
    notFoundBody: (doc: string, id: string) => string;
    kinds: Record<'mail' | 'photo' | 'screen' | 'form' | 'invoice' | 'tender' | 'sheet' | 'letter' | 'call', string>;
  };
  find: {
    cards: string;
    cardWords: string;
  };
}
