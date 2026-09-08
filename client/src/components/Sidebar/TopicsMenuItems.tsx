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
import { Archive, Grid2x2, History, Hourglass, LayoutTemplate, List, RotateCcw, Settings as SettingsIcon, Eye } from 'lucide-react';
import { nextSidebarViewMode, type SidebarViewMode } from '@/hooks/useSidebarState';
import { SETTINGS_SECTIONS } from '../Settings/sections';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { menuRowClass } from './menuRow';
import { openSettings } from '@/lib/openSettings';
import { useT } from '@/hooks/useT';

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
  onClose,
}: TopicsMenuItemsProps) {
  const tr = useT();
  const row = menuRowClass(isMobile);
  const glyph = isMobile ? 18 : 14;
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
          <span data-testid="topics-menu-view-tail" className="flex-shrink-0 text-[11px] text-app-text-tertiary">
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

      {/* History belongs to the column, not to the browser pane: it is the one
          place you look for something you had open and no longer know where.
          It opens the palette on its own perimeter: closed tabs and visited
          pages, mixed by time. */}
      <button
        type="button"
        onClick={onOpenHistory}
        className={row}
        data-testid="topics-menu-history"
      >
        <History size={glyph} className="flex-shrink-0" />
        <span className="flex-1 text-left">{tr('palette.history')}</span>
      </button>

      {/* SETTINGS LAND ON THE SECTION, not on the panel. Opening the panel and
          then finding the row inside it is two searches for one intention, and
          the second one happens in a rail the menu already knows by heart: the
          sections are DATA (`SETTINGS_SECTIONS`), the same list the panel draws
          itself from, so a section added there appears here without a second
          list to keep aligned. The row itself still opens the panel plain, for
          whoever does not know which section they want. */}
      <SubmenuItem
        icon={SettingsIcon}
        label={tr('app.settings')}
        testId="topics-menu-settings"
        minWidth={230}
      >
        {SETTINGS_SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => { onClose(); openSettings(section.id); }}
              data-testid={`topics-menu-settings-${section.id}`}
              className={row}
            >
              <Icon size={glyph} className="flex-shrink-0" />
              <span className="flex-1 text-left">{tr(section.labelKey)}</span>
            </button>
          );
        })}
        <div className="border-t border-app-border" />
        <button
          type="button"
          onClick={onOpenSettings}
          className={row}
          data-testid="topics-menu-settings-all"
        >
          <SettingsIcon size={glyph} className="flex-shrink-0" />
          <span className="flex-1 text-left">{tr('app.settingsAll')}</span>
        </button>
      </SubmenuItem>
    </>
  );
}
