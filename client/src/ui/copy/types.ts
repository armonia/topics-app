import type { NavKind } from '../types';
import type { KitCopy } from './kit';
import type { AppCopy } from './app';
import type { WorkCopy } from './work';
import type { FlowBuildCopy } from './flow-build';
import type { FlowRunCopy } from './flow-run';
import type { TeamCopy } from './team';
import type { SettingsCopy } from './settings';
import type { DataMoreCopy } from './data-more';
import type { KnowledgeMoreCopy } from './knowledge-more';
import type { ViewsMoreCopy } from './views-more';
import type { ProgramsCopy } from './programs';
import type { OrgsCopy } from './orgs';
import type { KanbanCopy } from './kanban';
import type { ContractsCopy } from './contracts';
import type { OrbitWorkCopy } from './orbit-work';
import type { OrbitDataCopy } from './orbit-data';
import type { OrbitAdminCopy } from './orbit-admin';
import type { FiltersCopy } from './filters';
import type { OrbitShellCopy } from './orbit-shell';
import type { OrbitTeamCopy } from './orbit-team';
import type { ChatCopy } from './chat';

/**
 * The product's own words in the UI layer, one catalogue per language
 * (`i18n-ui-it.ts`, `i18n-ui-en.ts`). Only generic product chrome lives here:
 * words that belong to a customer or a sector (a "pratica", a "protocollo")
 * arrive with the data, so the same screen serves every sector.
 * Components never pick a language: the caller passes the catalogue.
 */
export interface UiCopy {
  common: {
    uses: string;
    produces: string;
    opens: (target: string) => string;
    page: (n: number) => string;
    ai: string;
    accept: string;
    discard: string;
    open: string;
    expand: string;
    collapse: string;
    /** The label of a back control, naming the place it returns to. */
    back: (place: string) => string;
    close: string;
  };
  /**
   * What a navigable preview says about itself: a place that is not built yet,
   * an example whose data is not loaded, an action that does nothing here.
   */
  preview: {
    missing: (place: string) => string;
    missingBody: string;
    notLoaded: string;
    notLoadedBody: string;
    onlyMonth: string;
    unavailable: string;
    newTabTitle: string;
    emptyCollection: string;
    noUsage: string;
    original: string;
    originalNotLoaded: string;
    originNotLoaded: string;
    whereFrom: string;
    versions: string;
    goHome: string;
    openInbox: string;
    openTable: (table: string) => string;
    openFlow: (flow: string) => string;
    backToSteps: string;
    backToMonth: string;
    backToText: string;
    backToTable: string;
    backToDocuments: string;
    backToDraft: string;
    inQueue: (n: number) => string;
  };
  shell: {
    appName: string;
    notifications: string;
    search: string;
    newItem: string;
    toggleSidebar: string;
    addTab: string;
    closeTab: string;
    board: string;
    boardFlows: string;
    boardInbox: string;
    nav: Record<NavKind, string>;
    subagents: (n: number) => string;
    filters: string;
    pinned: string;
  };
  flows: {
    root: string;
    views: { steps: string; byOffice: string; runs: string; tests: string; versions: string; log: string };
    viewsLabel: string;
    tryIt: string;
    trigger: string;
    rule: string;
    person: string;
    /** The one drawing of a flow: the column of steps, and the cases side by side where it splits. */
    canvas: {
      label: string;
      /** The head of a split: what decides the case and how many cases there are. */
      split: (n: number, by: string) => string;
      /** The strip of cases side by side, for a screen reader. */
      lanes: (n: number) => string;
      prev: string;
      next: string;
      /** Under the cases: they meet again and the flow goes on. */
      rejoin: string;
      /** The lane the case on show takes, and the others. */
      taken: string;
      other: string;
      /** A lane with no steps of its own: it goes straight on. */
      noSteps: string;
      /** The detail of one step beside the flow. */
      detail: { title: string; close: string; who: string; uses: string; produces: string; originals: string; state: Record<'done' | 'current' | 'error' | 'waiting' | 'next', string>; none: string };
    };
  };
  inbox: {
    all: string;
    overdue: string;
    filterLabel: string;
    keysScroll: string;
    keysConfirm: string;
    keysCorrect: string;
    whatItSays: string;
    proposed: string;
    editable: string;
    hoverForSource: string;
    /** The same hint where a click, not a hover, opens the origin. */
    pickForSource: string;
    correctedByYou: string;
    afterConfirm: string;
    proposal: (value: string) => string;
    why: (value: string) => string;
    use: (value: string) => string;
    openDocument: string;
    sourcesConsulted: (n: number) => string;
    notForUs: string;
    askAssistant: string;
    openOriginals: string;
    confidence: (pct: number) => string;
  };
  record: {
    documents: string;
    data: string;
    history: string;
    sectionsLabel: string;
    saveDraft: string;
    bold: string;
    italic: string;
    list: string;
    improve: string;
    aiProposal: string;
    verifySources: string;
    draft: string;
    signed: string;
    openOnRight: string;
    composer: string;
    send: string;
    done: string;
    toDo: string;
    current: string;
    /** «Passo 2 di 6»: where the record is on a phone, where the strip shows only dots. */
    phaseOf: (n: number, total: number) => string;
  };
  data: {
    root: string;
    views: { table: string; byStatus: string; calendar: string; chart: string };
    viewsLabel: string;
    exportExcel: string;
    tables: string;
    savedViews: string;
    addFilter: string;
    selected: (n: number) => string;
    changeOwner: string;
    moveDeadline: string;
    exportRows: string;
    archive: string;
    shown: (shown: string, total: string) => string;
    linked: string;
    rowHistory: string;
    selectRow: string;
  };
  knowledge: {
    root: string;
    collections: string;
    text: string;
    versions: (n: number) => string;
    usedBy: string;
    tabsLabel: string;
    derivedRules: string;
    locked: string;
  };
  overview: {
    title: string;
    week: string;
    month: string;
    year: string;
    periodLabel: string;
    customize: string;
    exportAll: string;
    whatNow: string;
    columns: { flow: string; perMonth: string; avgTime: string; toPerson: string; corrected: string; errors: string; stuck: string };
    weekday: string;
    weekend: string;
    /** Header of the day column in the chart's table view. */
    day: string;
  };
  views: {
    root: string;
    layers: string;
    createPresentation: string;
    checks: string;
    originals: string;
    map: string;
  };
  /* The areas of the organizations preview, one catalogue each. */
  kit: KitCopy;
  app: AppCopy;
  work: WorkCopy;
  flowBuild: FlowBuildCopy;
  flowRun: FlowRunCopy;
  team: TeamCopy;
  settings: SettingsCopy;
  dataMore: DataMoreCopy;
  knowledgeMore: KnowledgeMoreCopy;
  viewsMore: ViewsMoreCopy;
  programs: ProgramsCopy;
  orgs: OrgsCopy;
  kanban: KanbanCopy;
  contracts: ContractsCopy;
  orbitWork: OrbitWorkCopy;
  orbitData: OrbitDataCopy;
  orbitAdmin: OrbitAdminCopy;
  filters: FiltersCopy;
  orbitShell: OrbitShellCopy;
  orbitTeam: OrbitTeamCopy;
  chat: ChatCopy;
}
