/**
 * The contract between the container of the preview (`App.tsx`) and the
 * screens of each area (`screens/<area>.tsx`). An area declares its places
 * (`ScreenDef`: an address pattern, the mockup id it draws, where it sits in
 * the sidebar, who may open it) and renders them from a `ScreenCtx`, which
 * carries everything a screen may use: the words, the state and the way to
 * change it, navigation, the current person and their permissions, toasts,
 * confirmations, simulated jobs. Areas never import each other: they link by
 * address (`paths.ts`).
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { UiCopy } from '../../ui/copy/types';
import type { SearchKind } from '../../ui/copy/app';
import type { Action, UiTabKind } from '../../ui/types';
import type { MenuHeaderModel, MenuItemModel } from '../../ui/primitives/Menu';
import type { OrgKey } from '../../ui/fixtures/org/types';
import type { Permission, Persona } from '../../ui/fixtures/org/people';
import type { AuditEntry, CaseLive, DemoAction, DemoState, NotificationEntry } from './store/state';

export type Params = Record<string, string>;

/** The sidebar rows a screen can light, inside its organization. */
export type NavId =
  | 'today' | 'inbox' | 'flows' | 'data' | 'knowledge' | 'views' | 'channels' | 'programs'
  | 'overview' | 'settings' | 'board' | 'callcenter' | 'org' | 'search' | 'new' | 'contracts' | 'team'
  | `chat:${string}` | `pin:${string}`;

export interface TabInfo {
  /** Places with the same key share a tab (one per surface, record, flow). */
  key: string;
  label: string;
  kind: UiTabKind;
  count?: number;
}

export interface ScreenDef {
  /** The mockup id this place draws (`png/<id>.png`), set as `data-screen`. */
  id: string;
  /**
   * The address pattern, `:name` for a parameter: `/flussi/:flow/passo/:step`.
   * Static segments win over parameters, so `/flussi/nuovo` beats `/flussi/:flow`. (allow-italian: quotes the Italian interface)
   */
  path: string;
  org: OrgKey;
  nav: NavId;
  /**
   * Concrete addresses that show this place (the first one is the canonical
   * one): the gallery, the screenshots, the walk and the crawl open them.
   */
  samples: string[];
  /** What the current person needs to open it; without it the container draws «no access». */
  needs?: Permission;
  /** The tab this place lives in. Default: one tab per `org` + `nav`. */
  tabKey?: (p: Params) => string;
  /** A place that opens no tab (the page after signing out): it is not somewhere to come back to. */
  transient?: boolean;
  /**
   * Places that draw the same page with something open on top (a card and the
   * same card with its flow panel) share this key, so moving between them does
   * not remount the page: the queue keeps its scroll, the card stays put.
   * Default: the address.
   */
  paneKey?: (p: Params) => string;
  /** How that tab looks when the place sets it apart: label, kind, count. */
  tab?: (p: Params, ctx: ScreenCtx) => Partial<Omit<TabInfo, 'key'>>;
  /** The name of the place: tab label, search result, history. */
  title: (p: Params, ctx: ScreenCtx) => string;
  render: (p: Params, ctx: ScreenCtx) => ReactNode;
  /**
   * A place may say it is not this one after all (a step of another kind, a
   * record that does not exist): return the mockup id it really draws.
   */
  screenId?: (p: Params, ctx: ScreenCtx) => string;
}

/** A thing the search (top bar and Cmd+K) can find and open. */
export interface SearchEntry {
  id: string;
  /** What kind of thing, for grouping: «Pratiche», «Norme», «Flussi», «Persone», «Impostazioni». (allow-italian: quotes the Italian interface) */
  group: string;
  title: string;
  detail?: string;
  /** Extra words that should find it (numbers, synonyms, the text of an article). */
  keywords?: string;
  path: string;
  icon: LucideIcon;
  needs?: Permission;
  /** The kind of thing, for the palette's groups and their order; without it the entry sits under its `group` label after the known kinds. */
  kind?: SearchKind;
  /** The number or code that names it (a card id): ranks like the title; the line under the title says it too. */
  ref?: string;
  /** Facts about it that should find it, each a short line (a place, an extracted value): the one that matched is shown when the title and the line do not hold the words. */
  facets?: string[];
}

export interface ToastInput {
  tone?: 'ok' | 'info' | 'warn' | 'error';
  title: string;
  body?: string;
  /** A way on from the toast, e.g. «Apri la ricevuta». (allow-italian: quotes the Italian interface) */
  action?: { label: string; path: string };
}

export interface ConfirmInput {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  onConfirm: () => void;
}

/** A simulated piece of work with visible progress: a test run, sending a PEC, a filing. */
export interface JobInput {
  id: string;
  title: string;
  steps: Array<{ label: string; ms: number; fails?: boolean }>;
  /** Called once at the end, with whether every step passed. */
  onDone?: (ok: boolean) => void;
}

export interface JobState {
  id: string;
  title: string;
  /** 0-1 */
  progress: number;
  current?: string;
  status: 'running' | 'done' | 'failed';
  done: string[];
  failed?: string;
}

export interface ScreenCtx {
  copy: UiCopy;
  state: DemoState;
  dispatch: (a: DemoAction) => void;
  /** Opens a place by its address (`/pratiche/2418`). */
  go: (path: string) => void;
  /** The address on show, without `#`. */
  path: string;
  persona: Persona;
  can: (p: Permission) => boolean;
  /**
   * The handler if the person may do it, `false` otherwise (the control is
   * drawn disabled). Pair with `deniedTitle` for the tooltip that says why.
   */
  allow: (p: Permission, fn: () => void) => Action;
  /** Why a control is off for this person, in one line; undefined when allowed. */
  deniedTitle: (p: Permission) => string | undefined;
  toast: (t: ToastInput) => void;
  confirm: (c: ConfirmInput) => void;
  /** Screen state that survives navigation and reload: `const [f, setF] = ctx.ui('dati.filtro', 'aperte')`. */
  ui: <T>(key: string, initial: T) => readonly [T, (next: T | ((prev: T) => T)) => void];
  /** Domain state of an area: added flows, test results, approvals. */
  slice: <T>(name: string, initial: T) => readonly [T, (fn: (prev: T) => T) => void];
  /** What the reader changed on a case, and how to change it (also logs to the audit). */
  caseLive: (id: string) => CaseLive;
  updateCase: (id: string, patch: (live: CaseLive) => CaseLive, log?: string) => void;
  /** Adds a line to the log that cannot be edited. */
  log: (what: string, kind: AuditEntry['kind'], path?: string) => void;
  notify: (n: Omit<NotificationEntry, 'id' | 'at'>) => void;
  startJob: (job: JobInput) => void;
  job: (id: string) => JobState | undefined;
  /** Under 768px: the phone layout. */
  phone: boolean;
  /** ISO date-time of the demo's now (`fixtures/org/clock.ts`). */
  now: string;
}

/**
 * An address that moved: the container replaces it with `to` (no new history
 * entry) before drawing, so an old link, a bookmark or a reload lands on the
 * place that took its content. `ui` sets screen state on the way, for an old
 * address that carried a filter (a flow, a stage).
 */
export interface RedirectDef {
  /** A pattern, as `ScreenDef.path`: `/contratti/:id`. (allow-italian: quotes the Italian interface) */
  from: string;
  to: (p: Params) => string;
  /** Screen state to write (`ctx.ui` keys) before the place draws. */
  ui?: (p: Params) => Record<string, unknown>;
}

/** What the shell hands an edition when it builds the menu of the organization or of the person. */
export interface ShellMenuCtx {
  ctx: ScreenCtx;
  /** How many notifications the person has not read. */
  unread: number;
  markAllRead: () => void;
  /** Opens the change of person of the demo (the `PersonaMenu`). */
  openPersonaSwitch: () => void;
}

/** An item of those menus with what picking it does; the shell closes the menu after it runs. */
export interface ShellMenuItem extends MenuItemModel {
  run?: () => void;
}

/** The menu of the person at the foot of the sidebar: their header (opens `onHeader`) and the items. */
export interface UserMenuModel {
  /** The accessible name of the menu. */
  label: string;
  header: MenuHeaderModel;
  onHeader?: () => void;
  items: ShellMenuItem[];
}

/** What an area hands the container: its places, and what search can find in it. */
export interface AreaModule {
  screens: ScreenDef[];
  search?: (ctx: ScreenCtx) => SearchEntry[];
  /** A few useful entries for the empty search field: what is stopped, what is due, where the work piles up. */
  suggest?: (ctx: ScreenCtx) => SearchEntry[];
}
