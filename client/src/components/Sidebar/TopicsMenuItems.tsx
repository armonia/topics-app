/**
 * THE COMMANDS OF THE COLUMN, written once and mounted twice.
 *
 * These rows used to live inline in `App.tsx`, inside the dropdown that opened
 * from the word «Topics» at the top of the sidebar. That title is not a menu
 * any more on the desktop: the whole submenu moved UNDER THE USER CARD at the
 * foot of the column, which is now the single door of the chrome (profile,
 * people, groups, machine, and these). The phone keeps its header menu, because
 * down there the column is a drawer and there is no identity band in it.
 *
 * Two surfaces, so the rows are a component and not a copy: the spec's own
 * words about the status rows apply verbatim here (SIDEBAR-STATUS-01, «the SAME
 * implementation on desktop and on phone: two copies of one answer are two
 * copies that one day answer differently»).
 *
 * ── WHY THEY ARE GROUPED NOW ────────────────────────────────────────────────
 * They were six flat rows, and flat is not neutral: «show archived», «view by
 * state», «merge the panels», «tile them», «history», «settings» read as one
 * list of six equal things, so finding the one you want means reading all six
 * every time. They are two subjects and two doors: WHAT THE COLUMN SHOWS (the
 * archived topics, the order they are in) and HOW THE WINDOW IS ARRANGED (the
 * panels). Each is a level, and the level says how it stands right now in its
 * tail, so the grouping does not cost the glance it saves.
 *
 * History stays a row of its own: it is not a setting of anything, it is a
 * place you go.
 *
 * WHAT IS NOT HERE: performance, version and restart. They are `SidebarSystemMenu`,
 * which was already one component for both screens, and they sit BELOW these
 * rows in either host: above the things that DO something, below the things
 * that SAY something.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { Archive, Globe2, Grid2x2, History, Hourglass, LayoutTemplate, List, RotateCcw, Settings as SettingsIcon, Eye } from 'lucide-react';
import { nextSidebarViewMode, type SidebarViewMode } from '@/hooks/useSidebarState';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { menuRowClass } from './menuRow';
import { useT } from '@/hooks/useT';
import { buildHistoryRows } from '@/lib/historyRows';
import { pagesSnapshot, subscribeSites } from '@/state/browserSiteHistory';
import { useClosedTabs } from '@/state/pane/adapters';
import type { ClosedTabRecord } from '@/state/pane/adapters/closedTabRecord';

/** How many rows the quick preview shows before it hands off to «See all».
 *  Enough to answer «where was I» at a glance, not enough to turn a submenu
 *  into a second command palette. */
const HISTORY_PREVIEW_ROWS = 6;

/** One or two characters: the row has no room for more. */
function formatRowAge(at: number): string {
  const diffMin = Math.floor((Date.now() - at) / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export interface TopicsMenuItemsProps {
  /** The finger or the mouse: passed in, never measured here, so the trigger
   *  and its rows cannot end up sized for two different hands. */
  isMobile: boolean;
  showArchived: boolean;
  onToggleArchived: () => void;
  viewMode: SidebarViewMode;
  onToggleViewMode: () => void;
  /** The two panel commands exist only where panels do (`useSplitLayoutAvailable`):
   *  under 768px they would not fail, they would do nothing. */
  splitLayoutAvailable: boolean;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  /** Reopens a closed tab exactly where it was. Optional: without it the
   *  quick preview still shows the row, it just cannot act on it and the
   *  row falls back to opening the full history in the palette. */
  onReopenClosedTab?: (record: ClosedTabRecord) => void;
  /** A visited page's URL, into a fresh browser pane. Same optionality as
   *  above and for the same reason. */
  onOpenHistoryUrl?: (url: string) => void;
  /** Closes whichever menu is hosting these rows. */
  onClose: () => void;
}

export function TopicsMenuItems({
  isMobile,
  showArchived,
  onToggleArchived,
  viewMode,
  onToggleViewMode,
  splitLayoutAvailable,
  onOpenHistory,
  onOpenSettings,
  onReopenClosedTab,
  onOpenHistoryUrl,
  onClose,
}: TopicsMenuItemsProps) {
  const tr = useT();
  const row = menuRowClass(isMobile);
  const glyph = isMobile ? 18 : 14;
  const { closedTabs } = useClosedTabs();
  const pages = useSyncExternalStore(subscribeSites, pagesSnapshot, pagesSnapshot);
  // A PREVIEW, NOT A COPY OF THE PALETTE. The dropdown's whole point is to
  // answer «where was I» without a second window; past a handful of rows
  // that stops being a glance, so the list is capped and «see all» remains
  // the one door into the full, searchable history.
  const historyRows = useMemo(
    () => buildHistoryRows({
      closedTabs: onReopenClosedTab ? closedTabs : [],
      pages: onOpenHistoryUrl ? pages : [],
      limit: HISTORY_PREVIEW_ROWS,
    }),
    [closedTabs, pages, onReopenClosedTab, onOpenHistoryUrl],
  );
  // The icon and the label describe the NEXT mode, which is what the click
  // does, and they ask the same function the toggle moves with: two hand
  // written lists of cases diverge at the first mode added or removed.
  const next = nextSidebarViewMode(viewMode);
  const NextIcon = next === 'state' ? Hourglass : List;

  return (
    <>
      {/* WHAT THE COLUMN SHOWS. The tail is the state you would otherwise have
          to open the level to read: which order the tree is in, and whether
          the archived ones are in it. */}
      <SubmenuItem
        icon={Eye}
        label={tr('app.viewGroup')}
        testId="topics-menu-view"
        minWidth={230}
        tail={
          <span data-testid="topics-menu-view-tail" className="flex-shrink-0 text-mini text-app-text-tertiary">
            {viewMode === 'state' ? tr('app.viewByStateShort') : tr('app.viewTimelineShort')}
            {showArchived ? ` \u00b7 ${tr('app.archivedShort')}` : ''}
          </span>
        }
      >
        <button
          type="button"
          onClick={onToggleArchived}
          data-testid="topics-menu-archived"
          className={`${row} ${showArchived ? 'text-primary' : ''}`}
        >
          <Archive size={glyph} className={`flex-shrink-0 ${showArchived ? 'text-primary' : ''}`} />
          <span className="flex-1 text-left">{tr('app.showArchived')}</span>
        </button>

        <button
          type="button"
          onClick={onToggleViewMode}
          data-testid="topics-menu-view-mode"
          className={row}
        >
          <NextIcon size={glyph} className="flex-shrink-0" />
          <span className="flex-1 text-left">
            {next === 'state' ? tr('app.viewByState') : tr('app.viewTimeline')}
          </span>
        </button>
      </SubmenuItem>

      {/* HOW THE WINDOW IS ARRANGED. Two commands that are each other's
          inverse, which is exactly the pair that reads badly flat: side by
          side in one level you see they are a choice, not two buttons. */}
      {splitLayoutAvailable && (
        <SubmenuItem
          icon={LayoutTemplate}
          label={tr('app.panelsGroup')}
          testId="topics-menu-panels"
          minWidth={230}
        >
          {/* The same per-window action the palette and the tab-bar context
              menu expose (the shared `topics:reset-split-layout` bus): every
              split collapses into the single standalone cell, where panes live
              as tabs. Nothing is closed and it is undoable. */}
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('topics:reset-split-layout'));
              onClose();
            }}
            data-testid="topics-menu-reset-panels"
            className={row}
            title={tr('app.mergePanels')}
          >
            <RotateCcw size={glyph} className="flex-shrink-0" />
            <span className="flex-1 text-left">{tr('app.resetPanels')}</span>
          </button>
          {/* The inverse: auto-tile every open standalone pane into its own
              cell in a balanced grid. Also undoable. */}
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('topics:auto-tile-layout'));
              onClose();
            }}
            data-testid="topics-menu-auto-tile"
            className={row}
            title={tr('app.tileAll')}
          >
            <Grid2x2 size={glyph} className="flex-shrink-0" />
            <span className="flex-1 text-left">{tr('app.autoArrange')}</span>
          </button>
        </SubmenuItem>
      )}

      {/* HISTORY IS A DROPDOWN NOW, not a door straight to the palette: a flat
          row that always opens a second window is a detour when the thing
          you are after is the tab you closed thirty seconds ago. The level
          shows the most recent handful, closed tabs and visited pages mixed
          by time exactly as the palette mixes them (`buildHistoryRows`), and
          «see all» at the bottom is still the one way into the full,
          searchable list. */}
      <SubmenuItem
        icon={History}
        label={tr('palette.history')}
        testId="topics-menu-history"
        minWidth={260}
      >
        {historyRows.length === 0 ? (
          <div className="px-3 py-2 text-mini text-app-text-secondary">{tr('palette.noHistory')}</div>
        ) : historyRows.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              onClose();
              if (entry.kind === 'tab' && entry.record && onReopenClosedTab) onReopenClosedTab(entry.record);
              else if (entry.url && onOpenHistoryUrl) onOpenHistoryUrl(entry.url);
            }}
            className={row}
            data-testid="topics-menu-history-row"
          >
            {entry.kind === 'page'
              ? <Globe2 size={glyph} className="flex-shrink-0" />
              : <RotateCcw size={glyph} className="flex-shrink-0" />}
            <span className="min-w-0 flex-1 truncate text-left">{entry.label || entry.detail || entry.url}</span>
            <span className="flex-shrink-0 text-micro text-app-text-tertiary tabular-nums">{formatRowAge(entry.at)}</span>
          </button>
        ))}
        <div className="border-t border-app-border" />
        <button
          type="button"
          onClick={() => { onClose(); onOpenHistory(); }}
          className={row}
          data-testid="topics-menu-history-all"
        >
          <History size={glyph} className="flex-shrink-0" />
          <span className="flex-1 text-left">{tr('palette.seeAllHistory')}</span>
        </button>
      </SubmenuItem>

      {/* SETTINGS IS A DOOR, NOT A SECOND RAIL. It used to open a submenu that
          listed the very same sections the settings panel already navigates
          by itself (`SETTINGS_SECTIONS`): one destination, reached by reading
          the same names twice, once here and once inside. The row now does
          the one thing its label promises - it opens the panel - and the
          panel is where you pick a section, because that list already lives
          there and does not need a second copy in a menu. */}
      <button
        type="button"
        onClick={onOpenSettings}
        className={row}
        data-testid="topics-menu-settings"
      >
        <SettingsIcon size={glyph} className="flex-shrink-0" />
        <span className="flex-1 text-left">{tr('app.settings')}</span>
      </button>
    </>
  );
}
