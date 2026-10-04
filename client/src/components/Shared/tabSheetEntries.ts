/**
 * WHAT THE TAB SHEET OFFERS, AND WHERE (TABSHEET-02, TABSHEET-03).
 *
 * Pure on purpose: the sheet's body hands in what a tab can do (callbacks
 * already bound to the tab, flags for what exists right now) and gets back the
 * tree of rows, so the rules of the shape are tested without a DOM
 * (`tabSheetEntries.test.ts`):
 *
 *   - the first level holds, in this order, the contextual rows that exist for
 *     this tab now, the search, the five level rows (Page, Tools, Session, Tab,
 *     Layout) and the two closes, and never more than eleven rows;
 *   - a level with ONE row does not exist: the row goes up to the first level;
 *     a level with none is not drawn (`shapeLevels`);
 *   - every command the tab menu and the browser sheet offered before has ONE
 *     place, and the page address is copied by one row only (the copy icon in
 *     the sheet's header, which this tree does not repeat).
 *
 * Rows that are a control rather than a command (the zoom stepper, the device
 * segments, the console list, the rename field) are `control` entries: the
 * body draws them, the tree only says where they go.
 */
import type { ComponentType } from 'react';
import {
  Hand, CornerUpLeft, ArrowUpRight, Search, Square, Settings, RotateCw, FileText, Wrench,
  MonitorSmartphone, PanelTop, LayoutGrid, X, Pin, PinOff, Link2, Maximize2, Maximize, Minimize2,
  Columns2, Rows2, Layers, Check, Plus, ExternalLink, Combine, Trash2, Code2,
} from 'lucide-react';

type Glyph = ComponentType<{ size?: number; className?: string }>;

/** A command: a click runs it and closes the sheet (unless `keepOpen`). */
export interface SheetAction {
  kind: 'action';
  id: string;
  label: string;
  icon?: Glyph;
  onSelect: () => void;
  testId?: string;
  /** A keyboard hint drawn at the end of the row. */
  hint?: string;
  title?: string;
  danger?: boolean;
  /** Drawn as the current choice and not clickable (the group the tab is in). */
  current?: boolean;
}

/** A row the body draws itself, because it is a control and not a command. */
export interface SheetControl {
  kind: 'control';
  id: 'zoom' | 'device' | 'console' | 'downloads' | 'share' | 'engine' | 'render' | 'rename';
}

export interface SheetLevel {
  kind: 'level';
  id: 'page' | 'tools' | 'session' | 'tab' | 'layout' | 'move-to-group';
  label: string;
  icon?: Glyph;
  /** What the level says while closed: zoom and device, errors, sharing. */
  tail?: string;
  /** The tail reports something broken. */
  tailDanger?: boolean;
  children: SheetEntry[];
}

export interface SheetDivider {
  kind: 'divider';
  id: string;
}

export type SheetEntry = SheetAction | SheetControl | SheetLevel | SheetDivider;

/** What a tab can do right now, bound by the body. Absent = not offered. */
export interface TabSheetModel {
  kind: 'browser' | 'chat' | 'terminal' | 'utility';
  /** The tab is the focused pane: the keyboard hints (Cmd+F, Cmd+W) act on it. */
  focused: boolean;
  /** Labels, already in the app's language. */
  t: (key: string, vars?: Record<string, string>) => string;
  /** Keyboard hints, already formatted for the platform; absent = not drawn. */
  hints?: { find?: string; close?: string };
  contextual?: {
    takeControl?: () => void;
    returnToChat?: () => void;
    openAsTab?: () => void;
    openInProject?: () => void;
    backToSpawner?: () => void;
  };
  stopTurn?: () => void;
  find?: () => void;
  chatSettings?: () => void;
  reloadSession?: () => void;
  page?: {
    zoom: boolean;
    device: boolean;
    forgetSite?: () => void;
    /** e.g. «100% · Desktop». */
    tail?: string;
  };
  tools?: {
    console: boolean;
    downloads: boolean;
    devTools?: () => void;
    devToolsHint?: string;
    errors: number;
    downloadCount: number;
  };
  session?: {
    share: boolean;
    engine: boolean;
    render: boolean;
    tail?: string;
  };
  tab?: {
    rename: boolean;
    /** One row for a top-level bar, two inside a project (project, this tab). */
    pins: Array<{ scope: 'single' | 'project' | 'tab'; pinned: boolean; toggle: () => void }>;
    copyLink?: () => void;
    /** On a browser tab the row says «link to the tab», not the page's. */
    copyLinkIsTabOfPage: boolean;
  };
  layout?: {
    zoom?: { zoomed: boolean; toggle: (scope: 'derived' | 'cell') => void };
    splitRight?: () => void;
    splitDown?: () => void;
    resetLayout?: () => void;
    moveToGroup?: {
      groups: Array<{ id: string; name: string; current: boolean }>;
      move: (groupId: string) => void;
      newGroup?: () => void;
      /** The name of the group the tab is in, for the row's tail. */
      currentName?: string;
    };
    detach?: () => void;
    reattach?: () => void;
    popOut?: () => void;
    popOutGroup?: () => void;
  };
  close?: () => void;
  closeOthers?: () => void;
}

/** The name of each device mode, as a catalogue key: the mode is an identifier. */
export const DEVICE_LABEL_KEY: Record<'desktop' | 'mobile' | 'tablet' | 'auto' | 'custom', string> = {
  desktop: 'tabSheet.device.desktop', mobile: 'tabSheet.device.mobile', tablet: 'tabSheet.device.tablet',
  auto: 'tabSheet.device.auto', custom: 'tabSheet.device.custom',
};

/** The first level may not grow past this many rows (TABSHEET-02). */
export const FIRST_LEVEL_MAX_ROWS = 11;

const action = (a: Omit<SheetAction, 'kind'>): SheetAction => ({ kind: 'action', ...a });
const control = (id: SheetControl['id']): SheetControl => ({ kind: 'control', id });
const divider = (id: string): SheetDivider => ({ kind: 'divider', id });

/**
 * A level with one row does not exist (its row takes its place), a level with
 * none is not drawn, and a divider never opens, closes or doubles a list.
 * Applied at every depth, inside out.
 */
export function shapeLevels(entries: readonly SheetEntry[]): SheetEntry[] {
  const out: SheetEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'level') {
      out.push(entry);
      continue;
    }
    const children = shapeLevels(entry.children);
    const rows = children.filter((c) => c.kind !== 'divider');
    if (rows.length === 0) continue;
    if (rows.length === 1) {
      out.push(rows[0]);
      continue;
    }
    out.push({ ...entry, children });
  }
  return tidyDividers(out);
}

function tidyDividers(entries: SheetEntry[]): SheetEntry[] {
  const out: SheetEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'divider' && (out.length === 0 || out[out.length - 1].kind === 'divider')) continue;
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1].kind === 'divider') out.pop();
  return out;
}

/** The rows a person counts on a level: everything but the dividers. */
export function rowCount(entries: readonly SheetEntry[]): number {
  return entries.filter((e) => e.kind !== 'divider').length;
}

function pinLabel(t: TabSheetModel['t'], scope: 'single' | 'project' | 'tab', pinned: boolean): string {
  if (scope === 'project') return t(pinned ? 'tab.menu.unpinProject' : 'tab.menu.pinProject');
  if (scope === 'tab') return t(pinned ? 'tab.menu.unpinTab' : 'tab.menu.pinTab');
  return t(pinned ? 'tab.menu.unpin' : 'tab.menu.pin');
}

/** The whole tree for one tab, already shaped. */
export function buildTabSheetEntries(m: TabSheetModel): SheetEntry[] {
  const { t } = m;
  const out: SheetEntry[] = [];

  // 1. CONTEXTUAL: who drives it, where it lives. Only what exists now.
  const c = m.contextual ?? {};
  if (c.takeControl) out.push(action({ id: 'take-control', label: t('browser.agent.takeControl'), icon: Hand, onSelect: c.takeControl, testId: 'tab-sheet-take-control' }));
  if (c.returnToChat) out.push(action({ id: 'return-to-chat', label: t('topicBrowser.returnToChat'), icon: CornerUpLeft, onSelect: c.returnToChat, testId: 'browser-tab-return-to-window' }));
  if (c.openAsTab) out.push(action({ id: 'open-as-tab', label: t('topicBrowser.openAsTab'), icon: ExternalLink, onSelect: c.openAsTab, testId: 'tab-sheet-open-as-tab' }));
  if (c.openInProject) out.push(action({ id: 'open-in-project', label: t('board.task.openTabInProject'), icon: ArrowUpRight, onSelect: c.openInProject, testId: 'tab-menu-open-in-project', title: t('board.task.openTabInProjectTitle') }));
  if (c.backToSpawner) out.push(action({ id: 'back-to-spawner', label: t('browser.spawner.title'), icon: CornerUpLeft, onSelect: c.backToSpawner, testId: 'browser-tab-spawner' }));
  if (m.stopTurn) out.push(action({ id: 'stop-turn', label: t('tab.menu.stopTurn'), icon: Square, onSelect: m.stopTurn, testId: 'tab-menu-stop' }));
  if (m.reloadSession) out.push(action({ id: 'reload-session', label: t('terminal.reload'), icon: RotateCw, onSelect: m.reloadSession, title: t('tab.restartSession'), testId: 'tab-sheet-reload-session' }));

  // 2. SEARCH, and the chat's own settings.
  out.push(divider('d-find'));
  if (m.find) {
    const label = m.kind === 'browser' ? t('tabSheet.find.page') : m.kind === 'chat' ? t('tabSheet.find.chat') : t('find.label');
    out.push(action({ id: 'find', label, icon: Search, onSelect: m.find, testId: 'tab-menu-find', hint: m.focused ? m.hints?.find : undefined }));
  }
  if (m.chatSettings) out.push(action({ id: 'chat-settings', label: t('chat.panel.topicSettings'), icon: Settings, onSelect: m.chatSettings, testId: 'tab-sheet-chat-settings' }));

  // 3. THE LEVELS, always in this order, so a place is learnt once.
  out.push(divider('d-levels'));
  if (m.page) {
    out.push({
      kind: 'level', id: 'page', label: t('tabSheet.level.page'), icon: FileText, tail: m.page.tail,
      children: [
        ...(m.page.zoom ? [control('zoom')] : []),
        ...(m.page.device ? [control('device')] : []),
        ...(m.page.forgetSite ? [divider('d-forget'), action({ id: 'forget-site', label: t('browser.forget.label'), icon: Trash2, onSelect: m.page.forgetSite, danger: true, testId: 'browser-tab-forget-site' })] : []),
      ],
    });
  }
  if (m.tools) {
    const { errors, downloadCount } = m.tools;
    out.push({
      kind: 'level', id: 'tools', label: t('tabSheet.level.tools'), icon: Wrench,
      tail: errors > 0
        ? t(errors === 1 ? 'tabSheet.tail.error' : 'tabSheet.tail.errors', { n: String(errors) })
        : downloadCount > 0
          ? t(downloadCount === 1 ? 'tabSheet.tail.download' : 'tabSheet.tail.downloads', { n: String(downloadCount) })
          : undefined,
      tailDanger: errors > 0,
      children: [
        ...(m.tools.console ? [control('console')] : []),
        ...(m.tools.downloads ? [control('downloads')] : []),
        ...(m.tools.devTools ? [action({ id: 'devtools', label: t('tabSheet.devTools'), icon: Code2, onSelect: m.tools.devTools, hint: m.tools.devToolsHint, testId: 'browser-tab-devtools' })] : []),
      ],
    });
  }
  if (m.session) {
    out.push({
      kind: 'level', id: 'session', label: t('tabSheet.level.session'), icon: MonitorSmartphone, tail: m.session.tail,
      children: [
        ...(m.session.share ? [control('share')] : []),
        ...(m.session.engine ? [control('engine')] : []),
        ...(m.session.render ? [control('render')] : []),
      ],
    });
  }
  if (m.tab) {
    const tabRows: SheetEntry[] = [];
    if (m.tab.rename) tabRows.push(control('rename'));
    for (const pin of m.tab.pins) {
      tabRows.push(action({
        id: `pin-${pin.scope}`, label: pinLabel(t, pin.scope, pin.pinned), icon: pin.pinned ? PinOff : Pin, onSelect: pin.toggle,
        testId: `tab-menu-pin-${pin.scope === 'project' ? 'project' : 'tab'}`,
      }));
    }
    if (m.tab.copyLink) {
      tabRows.push(action({
        id: 'copy-link', label: t(m.tab.copyLinkIsTabOfPage ? 'tab.menu.copyTabLink' : 'tab.menu.copyLink'), icon: Link2,
        onSelect: m.tab.copyLink, title: t('tab.copyLink'), testId: 'tab-sheet-copy-link',
      }));
    }
    out.push({ kind: 'level', id: 'tab', label: t('tabSheet.level.tab'), icon: PanelTop, children: tabRows });
  }
  if (m.layout) {
    const l = m.layout;
    const rows: SheetEntry[] = [];
    if (l.zoom) {
      if (l.zoom.zoomed) {
        rows.push(action({ id: 'unzoom', label: t('tab.menu.unzoom'), icon: Minimize2, onSelect: () => l.zoom!.toggle('derived'), testId: 'tab-menu-unzoom' }));
      } else {
        rows.push(action({ id: 'zoom-pane', label: t('tab.menu.zoom'), icon: Maximize2, onSelect: () => l.zoom!.toggle('derived'), testId: 'tab-menu-zoom' }));
        rows.push(action({ id: 'zoom-cell', label: t('tab.menu.zoomCellOnly'), icon: Maximize, onSelect: () => l.zoom!.toggle('cell'), testId: 'tab-menu-zoom-cell' }));
      }
    }
    rows.push(divider('d-split'));
    if (l.splitRight) rows.push(action({ id: 'split-right', label: t('tab.menu.splitRight'), icon: Columns2, onSelect: l.splitRight, testId: 'tab-sheet-split-right' }));
    if (l.splitDown) rows.push(action({ id: 'split-down', label: t('tab.menu.splitDown'), icon: Rows2, onSelect: l.splitDown, testId: 'tab-sheet-split-down' }));
    if (l.resetLayout) rows.push(action({ id: 'reset-layout', label: t('tab.menu.resetLayout'), icon: LayoutGrid, onSelect: l.resetLayout, title: t('tab.flattenSplits'), testId: 'tab-sheet-reset-layout' }));
    rows.push(divider('d-move'));
    if (l.moveToGroup) {
      const g = l.moveToGroup;
      rows.push({
        kind: 'level', id: 'move-to-group', label: t('tab.moveToGroup'), icon: Layers, tail: g.currentName,
        children: [
          ...g.groups.map((group) => action({
            id: `group-${group.id}`, label: group.name, icon: group.current ? Check : undefined,
            onSelect: () => g.move(group.id), current: group.current,
          })),
          ...(g.newGroup ? [action({ id: 'new-group', label: t('tab.newGroup'), icon: Plus, onSelect: g.newGroup, testId: 'tab-sheet-new-group' })] : []),
        ],
      });
    }
    if (l.detach) rows.push(action({ id: 'detach', label: t('tab.splitOut'), icon: Columns2, onSelect: l.detach, title: t('tab.splitOut.hint'), testId: 'tab-sheet-detach' }));
    if (l.reattach) rows.push(action({ id: 'reattach', label: t('tab.reattach'), icon: Combine, onSelect: l.reattach, title: t('tab.reattach.hint'), testId: 'tab-sheet-reattach' }));
    if (l.popOut) rows.push(action({ id: 'pop-out', label: t('tab.popOut'), icon: ExternalLink, onSelect: l.popOut, title: t('tab.popOut.hint'), testId: 'tab-sheet-pop-out' }));
    if (l.popOutGroup) rows.push(action({ id: 'pop-out-group', label: t('tab.popOutGroup'), icon: ExternalLink, onSelect: l.popOutGroup, title: t('tab.popOutGroup.hint'), testId: 'tab-sheet-pop-out-group' }));
    out.push({ kind: 'level', id: 'layout', label: t('tabSheet.level.layout'), icon: LayoutGrid, children: rows });
  }

  // 4. THE CLOSES. One that closes now; the countdown stays on the X (D5).
  out.push(divider('d-close'));
  if (m.close) out.push(action({ id: 'close', label: t('tab.menu.close'), icon: X, onSelect: m.close, testId: 'tab-sheet-close', hint: m.focused ? m.hints?.close : undefined }));
  if (m.closeOthers) out.push(action({ id: 'close-others', label: t('tab.menu.closeOthers'), icon: X, onSelect: m.closeOthers, testId: 'tab-sheet-close-others' }));

  return shapeLevels(out);
}
