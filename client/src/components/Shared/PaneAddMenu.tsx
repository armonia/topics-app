/**
 * PaneAddMenu — single source of truth for the "+" / "Add pane" menu.
 *
 * Two callsites historically owned their own copy of this menu:
 *  - `PaneTabBar` (the top tab bar's "+" button)
 *  - `TopicTree` (the project header's "Add to project" button in the sidebar)
 *
 * They had the same row styling but drifted in:
 *   - data source (PaneTabBar derived items from `availableTypes`, TopicTree
 *     hard-coded a fixed list — Browser/Git would slip out of sync if a new
 *     pane type became addable for projects)
 *   - small visual nits (trigger icon size, ⌘N kbd hint)
 *
 * Now both render this `<PaneAddMenuItems>` body inside their own portal /
 * native overlay path. Only the *items* are shared; the trigger button and
 * portal wrapping stay per-consumer because they have different positioning
 * needs (overflow flip in PaneTabBar, group-hover reveal in the sidebar).
 *
 * Adding a new pane type to the `+` menu now means adding it to PANE_CONFIG
 * with the right `addableScopes` — no call-site changes anywhere.
 */
import { Fragment } from 'react';
import {
  MessageSquare,
  TerminalSquare,
  Globe,
  GitBranch,
  Activity,
  BookOpen,
  Cpu,
  Kanban,
  BarChart3,
  LayoutGrid,
  FolderOpen,
  FolderTree,
  FileCode,
  Eye,
  Terminal,
  Brain,
  type LucideIcon,
} from 'lucide-react';
import { ClaudeIcon } from './ClaudeIcon';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { getPaneConfig } from '../../state/pane/adapters';
import type { PaneType } from '../../types';

/** Lookup table from PaneConfig.icon → lucide component. Keep in sync with
 *  `PANE_CONFIG` icon names. Falls back to a generic terminal icon for
 *  unmapped names so the menu still renders something readable. */
const ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare,
  Terminal,
  TerminalSquare,
  Globe,
  GitBranch,
  FolderTree,
  FolderOpen,
  FileCode,
  Activity,
  BookOpen,
  Cpu,
  Kanban,
  Brain,
  BarChart3,
  LayoutGrid,
  Eye,
};

/** Shared row class. Identical between PaneTabBar and the sidebar so the
 *  items LOOK the same regardless of which portal hosts them. */
const ROW_CLASS =
  'w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors';

export interface PaneAddMenuItemsProps {
  /** Spawn a new chat in the current scope. Hidden when omitted. */
  onNewChat?: () => void;
  /** Spawn a new pane of `type` in the current scope. Required for any
   *  `availableTypes` entry to actually do something on click. */
  onAddPane?: (type: PaneType, subType?: string) => void;
  /** Pane types to expose below "New Chat", in render order. Typically
   *  derived from `getAddableTypesForScope(scope, …)`. */
  availableTypes?: readonly PaneType[];
  /** Show keyboard shortcut hints (e.g. ⌘N next to "New Chat"). True on the
   *  top tab bar (where Cmd+N targets the focused group); false in the
   *  sidebar (where Cmd+N would NOT target this specific project). */
  showShortcuts?: boolean;
  /** Called after any item is invoked, so the parent can close the menu. */
  onClose: () => void;
}

export function PaneAddMenuItems({
  onNewChat,
  onAddPane,
  availableTypes,
  showShortcuts,
  onClose,
}: PaneAddMenuItemsProps) {
  const [claudeSkipPermissions, setClaudeSkipPermissions] = useClaudeSkipPermissions();
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
  const isElectron = typeof window !== 'undefined' && !!(window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron;

  const choose = (fn: () => void) => () => { fn(); onClose(); };

  return (
    <>
      {onNewChat && (
        <button
          onClick={choose(onNewChat)}
          className={ROW_CLASS}
          data-testid="pane-add-menu-new-chat"
        >
          <MessageSquare size={14} className="flex-shrink-0" />
          <span className="flex-1 text-left">New Chat</span>
          {showShortcuts && isElectron && (
            <kbd className="kbd text-app-text-muted">{isMac ? '⌘' : '⌃'}N</kbd>
          )}
        </button>
      )}
      {onAddPane && availableTypes?.map((type) => {
        if (type === 'terminal') {
          // Terminal is the only pane type that splits into two menu rows
          // (Shell vs Claude Code) plus a per-row "yolo" toggle. Keep the
          // pair grouped under a Fragment so the React reconciler doesn't
          // confuse them with neighbors when `availableTypes` reorders.
          return (
            <Fragment key={type}>
              <button
                onClick={choose(() => onAddPane('terminal', 'shell'))}
                className={ROW_CLASS}
                data-testid="pane-add-menu-shell"
              >
                <TerminalSquare size={14} className="flex-shrink-0" />
                <span className="flex-1 text-left">Shell</span>
              </button>
              <button
                onClick={choose(() => onAddPane('terminal', 'claude-code'))}
                className={ROW_CLASS}
                data-testid="pane-add-menu-claude-code"
              >
                <ClaudeIcon size={14} className="text-[#D97757] flex-shrink-0" />
                <span className="flex-1 text-left">Claude Code</span>
                <label
                  className="flex items-center gap-1 text-[10px] text-app-text-muted"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={claudeSkipPermissions}
                    onChange={(e) => setClaudeSkipPermissions(e.target.checked)}
                    className="w-3 h-3 rounded accent-[#D97757]"
                  />
                  <span>yolo</span>
                </label>
              </button>
            </Fragment>
          );
        }
        const cfg = getPaneConfig(type);
        const Icon = ICON_MAP[cfg.icon];
        return (
          <button
            key={type}
            onClick={choose(() => onAddPane(type))}
            className={ROW_CLASS}
            data-testid={`pane-add-menu-${type}`}
          >
            {Icon ? <Icon size={14} className="flex-shrink-0" /> : null}
            <span className="flex-1 text-left">{cfg.label}</span>
          </button>
        );
      })}
    </>
  );
}
