/**
 * Organizations: the Board of all organizations, the direction overview, SARIM, the page of an organization.
 * The words of the `orgs` area of the preview; values in `i18n-ui-orgs-it.ts`
 * and `i18n-ui-orgs-en.ts`. Only product words: sector words arrive with the data.
 */
import type { BoardColumnId } from '../board/model';
import type { OverviewBlockId } from '../overview/model';

/** Status code of a flow as the data carries it; the words come from the copy. */
export type FlowStatusCode = 'attivo' | 'collaudo' | 'bozza' | 'spento'; // allow-italian: status codes of the data, not shown

export interface OrgsBoardCopy {
  title: string;
  searchPlaceholder: string;
  orgFilter: string;
  all: (n: number) => string;
  hint: string;
  moveTo: string;
  moveItem: (column: string) => string;
  columnEmpty: string;
  newCard: string;
  emptyTitle: string;
  emptyBody: string;
  clearFilters: string;
  columns: Record<BoardColumnId, string>;
  urgent: string;
  today: string;
  tomorrow: string;
  form: {
    title: string;
    titlePlaceholder: string;
    titleRequired: string;
    org: string;
    column: string;
    due: string;
    dueHint: string;
  };
  newCardTitle: string;
  editCardTitle: string;
  close: string;
  cancel: string;
  create: string;
  save: string;
  delete: string;
  toastMoved: (column: string) => string;
  caseNoBacklog: string;
  caseNoBacklogBody: string;
  logMoved: (title: string, column: string) => string;
  confirmCloseTitle: string;
  confirmCloseBody: (title: string) => string;
  confirmClose: string;
  logCreated: (title: string, org: string) => string;
  toastCreated: string;
  logEdited: (title: string) => string;
  toastSaved: string;
  confirmDeleteTitle: string;
  confirmDeleteBody: (title: string) => string;
  confirmDelete: string;
  logDeleted: (title: string) => string;
  toastDeleted: string;
}

export interface OrgsOverviewCopy {
  exportFile: string;
  /** A flow with items waiting in more than one office: «3 in 2 uffici». */
  stuckSeveral: (n: number, offices: number) => string;
  logExport: (file: string) => string;
  exportDone: string;
  exportBody: (file: string, rows: number) => string;
  blocks: Record<OverviewBlockId, { label: string; detail: string }>;
  moveUp: (block: string) => string;
  moveDown: (block: string) => string;
  done: string;
  reset: string;
  resetDone: string;
  close: string;
  customizeIntro: string;
  blocksLabel: string;
  noBlocks: string;
  noBlocksBody: string;
  showAll: string;
  saved: string;
  logCustomize: string;
}

export interface OrgsSarimCopy {
  always: string;
  flowsCount: (n: number) => string;
  newFlow: string;
  searchFlows: string;
  areaFilter: string;
  allAreas: string;
  noFlows: string;
  noFlowsBody: string;
  clearFilters: string;
  columns: { flow: string; area: string; trigger: string; status: string; perMonth: string; waiting: string };
  overviewDetail: string;
  /** The organization the SARIM screens are about, said in their titles. */
  orgName: string;
  overviewTitle: string;
  exportFile: string;
  statusLabel: (status: FlowStatusCode, version: number) => string;
  perMonthNote: (n: string) => string;
  plainPanel: { tag: string; title: string; description: string; section: string; access: string };
  flowNotFound: string;
  flowNotFoundBody: string;
  backToFlows: string;
}

export interface OrgsCallCenterCopy {
  asked: string;
  proposedService: string;
  turn: string;
  site: string;
  vehicle: string;
  notice: string;
  checked: string;
  inProgress: string;
  history: string;
  alreadyConfirmed: string;
  confirm: string;
  changeTurn: string;
  callBack: string;
  statusRinging: string;
  statusLive: string;
  statusEnded: (when: string) => string;
  incomingLabel: string;
  incomingTitle: string;
  incomingBody: string;
  answer: string;
  transcript: string;
  operator: string;
  caller: string;
  waitingAudio: string;
  transcribing: string;
  formTitle: string;
  notHeardYet: string;
  addressCheck: string;
  didYouMean: string;
  opening: string;
  reportOpened: string;
  goToReport: string;
  openReport: string;
  now: string;
  queue: (n: number) => string;
  queueEmpty: string;
  recentCalls: string;
  nothingOpen: string;
  nothingOpenBody: string;
  overdue: string;
  minutes: (n: number) => string;
  fields: { kind: string; street: string; number: string; city: string; urgency: string; contact: string };
  requiredField: string;
  address: {
    waiting: string;
    waitingBody: string;
    found: string;
    foundBody: (street: string, number: number, city: string) => string;
    checkNumber: string;
    checkNumberBody: (street: string, max: number) => string;
    notFound: string;
    notFoundBody: (street: string) => string;
  };
  exampleTag: string;
  proposalLine: (turn: string) => string;
  channelCall: string;
  callSource: (caller: string) => string;
  noDuplicates: string;
  confirmJob: string;
  confirmSteps: [string, string, string];
  orderOpened: (order: string) => string;
  receiptTurn: (turn: string, site: string) => string;
  receiptNotice: (notice: string, time: string) => string;
  receiptExample: string;
  eventConfirmed: (order: string) => string;
  logConfirmed: (title: string, order: string) => string;
  notifyOrder: (order: string) => string;
  toastConfirmed: string;
  toastOpen: string;
  eventTurn: (turn: string) => string;
  logTurn: (title: string, turn: string) => string;
  toastTurn: (turn: string) => string;
  callBackJob: string;
  callSteps: [string, string, string, string];
  eventCalledBack: string;
  toastCalledBack: string;
  eventNoAnswer: string;
  toastNoAnswer: string;
  toastNoAnswerBody: string;
  logCalledBack: (title: string, ok: boolean) => string;
  callJob: string;
  logAnswered: (caller: string) => string;
  toastAnswered: string;
  toastMissing: string;
  toastMissingBody: string;
  openJob: string;
  openSteps: [string, string, string];
  logOpened: (title: string) => string;
  toastOpened: string;
  notFound: string;
  notFoundBody: string;
  backToQueue: string;
}

export interface OrgsPageCopy {
  boardTitle: (n: number) => string;
  openBoard: string;
  noCards: string;
  members: (n: number) => string;
  startingSummary: string;
  flowsTitle: string;
  startingTitle: string;
  startingBody: string;
  startFromTemplate: string;
  configuresTitle: string;
  activeFlows: (n: number) => string;
}

export interface OrgsSearchCopy {
  organizations: string;
  organizationDetail: string;
  organizationWords: string;
  board: string;
  boardWords: string;
}

export interface OrgsCopy {
  board: OrgsBoardCopy;
  overview: OrgsOverviewCopy;
  sarim: OrgsSarimCopy;
  callCenter: OrgsCallCenterCopy;
  page: OrgsPageCopy;
  search: OrgsSearchCopy;
}
