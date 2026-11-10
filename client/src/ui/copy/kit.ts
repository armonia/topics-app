import type { FieldKind, NavKind, TabKind } from '../types';

/** A glyph of the legend: what it is called, and what it means. */
export interface GlyphWords {
  name: string;
  meaning: string;
}

/** Who does a step of a flow, the kinds of `flows/FlowStep.tsx` ActorChip. */
export type BlockKind = 'trigger' | 'rule' | 'ai' | 'person' | 'program';

/** The states the kit draws: the four kinds of a message, a lock, a wait. */
export type StateGlyph = 'ok' | 'info' | 'warn' | 'error' | 'locked' | 'loading';

/** The control glyphs the kit draws inside its components. */
export type ControlGlyph =
  | 'search' | 'close' | 'choose' | 'tick' | 'previous' | 'next'
  | 'zoomIn' | 'zoomOut' | 'fit' | 'download' | 'quote' | 'enter';

export type LegendGroup = 'blocks' | 'data' | 'surfaces' | 'tabs' | 'states' | 'controls';

/**
 * Words of the shared controls: dialogs, menus, fields, viewer, palette, toasts.
 * The words of the `kit` area of the preview; values in `i18n-ui-kit-it.ts`
 * and `i18n-ui-kit-en.ts`. Only product words: sector words arrive with the data.
 */
export interface KitCopy {
  /** Spoken name of a spinner that stands alone. */
  loading: string;
  /** The original document, page by page (`DocumentViewer`). */
  viewer: {
    toolbar: string;
    /** The rail of page thumbnails. */
    pages: string;
    goToPage: (n: number) => string;
    pageOf: (page: number, total: number) => string;
    previous: string;
    next: string;
    zoomOut: string;
    zoomIn: string;
    /** Back to the page filling the width. */
    fit: string;
    zoom: (pct: number) => string;
    download: string;
    /** Over the quoted passage, naming the page it comes from. */
    quote: (page: number) => string;
    pageImage: (name: string, page: number) => string;
  };
  /** The search over everything (`CommandPalette`). */
  palette: {
    results: string;
    move: string;
    open: string;
    close: string;
    keyUp: string;
    keyDown: string;
    keyEnter: string;
    keyEscape: string;
  };
  /** The state of a step, read by a screen reader (`Stepper`). */
  stepper: {
    label: string;
    done: string;
    current: string;
    todo: string;
  };
  /** The phone window (`PhoneShell`): its tab bar and its drawer. */
  phone: {
    nav: string;
    menu: string;
    closeMenu: string;
  };
  notifications: {
    unread: string;
  };
  /** The legend of the icon system (gallery `z01`). */
  legend: {
    crumb: string;
    title: string;
    lead: string;
    groups: Record<LegendGroup, { title: string; note: string }>;
    block: Record<BlockKind, GlyphWords>;
    field: Record<FieldKind, GlyphWords>;
    /** What each surface is for; its name is `shell.nav`. */
    surface: Record<NavKind, string>;
    tab: Record<TabKind, GlyphWords>;
    state: Record<StateGlyph, GlyphWords>;
    control: Record<ControlGlyph, GlyphWords>;
    rulesTitle: string;
    rules: string;
  };
  /** Example words of the gallery page `kit`: never shown by the product. */
  demo: KitDemoCopy;
}

/** The example content the `kit` gallery page fills its components with. */
export interface KitDemoCopy {
  title: string;
  lead: string;
  sections: {
    fields: string;
    choices: string;
    menus: string;
    tabs: string;
    progress: string;
    states: string;
    timeline: string;
    table: string;
    cards: string;
    stepper: string;
    overlays: string;
    viewer: string;
    phone: string;
    search: string;
  };
  reopen: string;
  closed: string;
  field: {
    name: string;
    namePlaceholder: string;
    nameHint: string;
    search: string;
    taxCode: string;
    taxCodeError: string;
    deadline: string;
    locked: string;
    lockedValue: string;
    lockedTitle: string;
    note: string;
    notePlaceholder: string;
    noteHint: string;
    office: string;
    offices: [string, string, string];
  };
  choice: {
    emailLabel: string;
    emailDescription: string;
    digestLabel: string;
    digestDescription: string;
    signLabel: string;
    signTitle: string;
    agree: string;
    archived: string;
    lockedBox: string;
  };
  menu: {
    actions: string;
    more: string;
    open: string;
    duplicate: string;
    export: string;
    archive: string;
    delete: string;
    deleteTitle: string;
    context: string;
  };
  tabs: { documents: string; data: string; history: string; label: string };
  progress: {
    sending: string;
    sendingDetail: string;
    test: string;
    testDetail: string;
    space: string;
    spaceDetail: string;
    overdue: string;
    overdueDetail: string;
  };
  states: {
    loading: string;
    errorTitle: string;
    errorBody: string;
    errorDetails: string;
    retry: string;
    noAccessTitle: string;
    noAccessBody: string;
    askAccess: string;
  };
  timeline: Array<{ title: string; detail?: string; who?: string; at: string }>;
  table: {
    label: string;
    columns: { record: string; person: string; status: string; due: string };
    rows: Array<{ record: string; person: string; status: string; due: string }>;
    empty: string;
  };
  cards: {
    deadlinesTitle: string;
    deadlinesBody: string;
    flowTitle: string;
    flowBody: string;
    stats: Array<{ label: string; value: string; detail: string }>;
  };
  steps: Array<{ label: string; detail?: string }>;
  overlays: {
    dialogTitle: string;
    dialogBody: string;
    save: string;
    cancel: string;
    confirmTitle: string;
    confirmBody: string;
    confirmLabel: string;
    popover: string;
    popoverBody: string;
    toasts: Array<{ title: string; body?: string; action?: string }>;
    dismiss: string;
    palette: string;
    paletteEmpty: string;
    paletteFooter: string;
    paletteGroups: Array<{ label: string; items: Array<{ title: string; detail: string }> }>;
    notifications: string;
    markAll: string;
    noNotifications: string;
    notificationItems: Array<{ title: string; body?: string; when: string }>;
    personas: string;
    example: string;
    current: string;
    personaItems: Array<{ name: string; detail: string }>;
  };
  viewer: {
    name: string;
    detail: string;
    quote: string;
    summary: string;
    summaryBody: string;
  };
  phone: {
    title: string;
    nav: [string, string, string, string];
    body: string;
  };
  search: { label: string; shortcut: string };
}
