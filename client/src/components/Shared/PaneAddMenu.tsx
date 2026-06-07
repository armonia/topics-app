/**
 * PaneAddMenu — single source of truth for the "+" / "Add pane" affordance.
 *
 * One component covers EVERY surface where the user can add a pane:
 *
 *   1. The trigger button (Plus icon, 14px, `bg-surface hover:bg-app-hover`)
 *   2. Click handling — including the Electron native overlay path used
 *      when a `WebContentsView` browser pane is open (the OS-level overlay
 *      paints above the React DOM, so a regular portal would render behind
 *      it; we delegate to a transparent BrowserWindow via `electronAPI.overlay`).
 *   3. Web fallback — a portaled dropdown anchored below the button with
 *      viewport overflow flip (so a button near the bottom of the screen
 *      flips its menu *upward*, no clipping).
 *   4. Mobile bottom-sheet variant — same items, slid up from the bottom
 *      with a safe-area-aware padding instead of an anchored card.
 *   5. The shared item list (`<PaneAddMenuItems>` below) — derived from
 *      `getAddableTypesForScope()` so adding a new pane type to PANE_CONFIG
 *      with the right `addableScopes` lights it up here automatically.
 *
 * Both callsites render `<PaneAddMenu />` as-is; the only differences they
 * configure via props are:
 *   - which scope's pane types are addable (`availableTypes`)
 *   - whether a `⌘N` hint applies (`showShortcuts` — true on the top tab
 *     bar, false in the sidebar where ⌘N targets the focused group, not
 *     this specific project)
 *   - presentation chrome around the trigger (`triggerClassName` lets the
 *     sidebar do `hidden group-hover/proj:flex` while the tab bar always
 *     shows the button).
 *
 * Anything visual or behavioural is owned here. The two old code paths
 * inside PaneTabBar / TopicTree have been deleted — this is the canonical
 * implementation.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  FolderPlus,
  FolderTree,
  FileCode,
  Eye,
  Terminal,
  Brain,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { ClaudeIcon } from './ClaudeIcon';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { useMobile } from '../../hooks/useMobile';
import { getPaneConfig } from '../../state/pane/adapters';
import type { PaneType } from '../../types';

/* ── Item list (re-rendered identically in every host) ─────────────────── */

/** Lookup table from PaneConfig.icon → lucide component. Keep in sync with
 *  `PANE_CONFIG` icon names. Unmapped names fall back to nothing (nullish). */
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

/** Subset accepted by the Electron overlay's `iconName` field (server-side
 *  renders SVG by name). Mapping mirrors ICON_MAP but with overlay-side
 *  string keys. Returns `'plus-square'` for any name we don't have.
 *
 *  Mirrors the lucide icons in `ICON_MAP` above so the Electron overlay and
 *  the web portal paint the same brand icons. Pre-fix the overlay only
 *  knew a small subset (`globe`, `terminal`, `bot`, `folder`, …) so Files /
 *  Git / Board Memory all fell through to the generic `plus-square` and
 *  Claude Code rendered a generic "bot" instead of the Anthropic glyph —
 *  which is exactly what made the user say the menus look different. */
type OverlayIconName =
  | 'globe'
  | 'terminal'
  | 'terminal-square'
  | 'message-square'
  | 'folder'
  | 'folder-tree'
  | 'git-branch'
  | 'brain'
  | 'file-code'
  | 'claude'
  | 'bot'
  | 'file-text'
  | 'layout'
  | 'list'
  | 'plus-square';
const OVERLAY_ICON_BY_LUCIDE: Record<string, OverlayIconName> = {
  Globe: 'globe',
  Terminal: 'terminal',
  TerminalSquare: 'terminal-square',
  MessageSquare: 'message-square',
  Folder: 'folder',
  FolderOpen: 'folder',
  FolderTree: 'folder-tree',
  GitBranch: 'git-branch',
  Brain: 'brain',
  FileCode: 'file-code',
  Bot: 'bot',
  FileText: 'file-text',
  Layout: 'layout',
  // No native overlay icon for kanban/grid yet — fall back to layout.
  Kanban: 'layout',
  LayoutGrid: 'layout',
  List: 'list',
};

/** Shared row class — identical for every host so the menu looks the same
 *  regardless of which portal renders it. */
const ROW_CLASS =
  'w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors';

/** Fire the global "open / create a project (native folder picker)" intent.
 *  Handled by a listener in App.tsx — kept event-based so EVERY PaneAddMenu
 *  host (top tab bar, sidebar project header) and the Electron native overlay
 *  path all trigger it identically, with no prop-threading. The native picker
 *  lets you select an existing folder OR create a new one. Electron-only. */
function openProjectPicker() {
  window.dispatchEvent(new CustomEvent('topics:open-project-picker'));
}

export interface PaneAddMenuItemsProps {
  /** Spawn a new chat in the current scope. Hidden when omitted. */
  onNewChat?: () => void;
  /** Spawn a new pane of `type` in the current scope. Required for any
   *  `availableTypes` entry to actually do something on click. */
  onAddPane?: (type: PaneType, subType?: string) => void;
  /** Pane types to expose below "New Chat", in render order. Typically
   *  derived from `getAddableTypesForScope(scope, …)`. */
  availableTypes?: readonly PaneType[];
  /** Show keyboard shortcut hints (e.g. ⌘N next to "New Chat"). True on
   *  the top tab bar (where Cmd+N targets the focused group); false in
   *  the sidebar (where Cmd+N would NOT target this specific project). */
  showShortcuts?: boolean;
  /** Show the "Apri / Crea Progetto" actions (native folder picker). Passed
   *  ONLY by the global / standalone add-menus — never by project-scoped ones
   *  (you don't open/create a project from inside a project's "+"). */
  showProjectActions?: boolean;
  /** Called after any item is invoked, so the parent can close the menu. */
  onClose: () => void;
}

export function PaneAddMenuItems({
  onNewChat,
  onAddPane,
  availableTypes,
  showShortcuts,
  showProjectActions,
  onClose,
}: PaneAddMenuItemsProps) {
  const [claudeSkipPermissions, setClaudeSkipPermissions] = useClaudeSkipPermissions();
  const { isMobile } = useMobile();
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;

  // Touch targets are bigger on mobile, so the icons need to scale up to
  // stay legible inside the larger row. Matches the pre-unification
  // behaviour of the three hand-rolled menus that all used
  // `size={isMobile ? 18 : 14}`.
  const iconSize = isMobile ? 18 : 14;

  const choose = (fn: () => void) => () => {
    fn();
    onClose();
  };

  // Curated render order. `getAddableTypesForScope` returns types in
  // PANE_CONFIG iteration order, which is fine for code structure but
  // wrong for menu UX: it puts low-frequency entries (Files, Board
  // Memory) above high-frequency ones (Shell, Claude Code). Match the
  // pre-unification hand-rolled menus' order — terminals first, then
  // Browser, Git, then less-frequent project utilities. Unknown types
  // (any future PaneType not in this list) appear at the end in their
  // declared order so adding a new addableScopes entry still surfaces
  // it without a code change here.
  const SORTED_AVAILABLE: PaneType[] = ['terminal', 'browser', 'git', 'files'];
  const orderedTypes = availableTypes
    ? [
        ...SORTED_AVAILABLE.filter((t) => availableTypes.includes(t)),
        ...availableTypes.filter((t) => !SORTED_AVAILABLE.includes(t)),
      ]
    : [];

  // Brand-tint the "New Chat" row with the chat pane's canonical accent
  // (PANE_CONFIG.chat.color = #0066ff) so it reads as part of the same
  // family as Claude Code's orange glyph and the brand-coloured rows
  // below. Without this New Chat alone stayed mono-ink and the menu
  // looked half-finished. Also matches the overlay's iconColor for the
  // 'new-chat' item — the two surfaces now paint identical icons.
  const chatColor = getPaneConfig('chat').color;

  return (
    <>
      {onNewChat && (
        <button
          onClick={choose(onNewChat)}
          className={ROW_CLASS}
          data-testid="pane-add-menu-new-chat"
        >
          <MessageSquare
            size={iconSize}
            className="flex-shrink-0"
            style={{ color: chatColor }}
          />
          <span className="flex-1 text-left">New Chat</span>
          {showShortcuts && isElectron && (
            <kbd className="kbd text-app-text-muted">{isMac ? '⌘' : '⌃'}N</kbd>
          )}
        </button>
      )}
      {onAddPane && orderedTypes.map((type) => {
        if (type === 'terminal') {
          // Shell uses the terminal palette accent (purple #8b5cf6 from
          // PANE_CONFIG.terminal.color) so it reads as "the same family
          // as Claude Code" — both are pty-based panes, both should
          // feel branded in the menu the way Claude does.
          const terminalCfg = getPaneConfig('terminal');
          return (
            <Fragment key={type}>
              <button
                onClick={choose(() => onAddPane('terminal', 'shell'))}
                className={ROW_CLASS}
                data-testid="pane-add-menu-shell"
              >
                <TerminalSquare size={iconSize} className="flex-shrink-0" style={{ color: terminalCfg.color }} />
                <span className="flex-1 text-left">Shell</span>
              </button>
              <button
                onClick={choose(() => onAddPane('terminal', 'claude-code'))}
                className={ROW_CLASS}
                data-testid="pane-add-menu-claude-code"
              >
                <ClaudeIcon size={iconSize} className="text-[#D97757] flex-shrink-0" />
                <span className="flex-1 text-left">Claude Code</span>
                <label
                  className="flex items-center gap-1 text-[11px] text-app-text-muted"
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
        // Brand-coloured every row — same idea as Claude Code's orange,
        // generalised. Each pane type carries a canonical accent in
        // `PANE_CONFIG.color` (browser → green, git → red, files →
        // amber, board-memory → green). Threading it through to the
        // icon makes the menu visually scannable and matches what the
        // user expects from a polished add-pane affordance.
        const iconStyle = cfg.color ? { color: cfg.color } : undefined;
        return (
          <button
            key={type}
            onClick={choose(() => onAddPane(type))}
            className={ROW_CLASS}
            data-testid={`pane-add-menu-${type}`}
          >
            {Icon ? <Icon size={iconSize} className="flex-shrink-0" style={iconStyle} /> : null}
            <span className="flex-1 text-left">{cfg.label}</span>
          </button>
        );
      })}
      {/* Open / create a PROJECT (native folder picker). Only in global /
          standalone add-menus (showProjectActions) — NOT inside a project's
          "+". Electron-only (needs the OS dialog). Divider above since these
          spin up a whole project window, not a pane. */}
      {isElectron && showProjectActions && (
        <>
          <div className="my-1 border-t border-app-border" />
          <button
            onClick={choose(openProjectPicker)}
            className={ROW_CLASS}
            data-testid="pane-add-menu-open-project"
          >
            <FolderOpen size={iconSize} className="flex-shrink-0 text-app-text-muted" />
            <span className="flex-1 text-left">Apri Progetto</span>
          </button>
          <button
            onClick={choose(openProjectPicker)}
            className={ROW_CLASS}
            data-testid="pane-add-menu-create-project"
          >
            <FolderPlus size={iconSize} className="flex-shrink-0 text-app-text-muted" />
            <span className="flex-1 text-left">Crea Progetto</span>
          </button>
        </>
      )}
    </>
  );
}

/* ── The full menu component ───────────────────────────────────────────── */

export interface PaneAddMenuProps extends Omit<PaneAddMenuItemsProps, 'onClose'> {
  /** Tooltip on the trigger button. Defaults to "Add pane". */
  triggerTitle?: string;
  /** Trigger button visual preset. Two flavours so the menu sits naturally
   *  alongside differently-sized neighbours without divergent code paths:
   *
   *   - `'pill'` (default) — 6×6 with a `bg-surface` plate that's visible
   *     at rest. Matches the tab bar's "+" and the sidebar project header
   *     "+" (both sit next to other 6×6 affordances).
   *   - `'ghost'` — 7×7 desktop / 10×10 mobile with no resting background,
   *     hover `bg-black/5`. Matches the global sidebar header icons
   *     (Settings, Remote, etc.).
   *
   *  The size also drives the inner `Plus` icon (14px / 18px). */
  triggerVariant?: 'pill' | 'ghost';
  /** Optional class to layer on top of the default trigger styling. The
   *  sidebar uses this to make the button hover-revealed on the project
   *  header row (`'hidden group-hover/proj:flex'`); the top tab bar leaves
   *  it empty so the button is always visible. */
  triggerClassName?: string;
  /** When true, mark the trigger as `app-no-drag` and set the equivalent
   *  inline style. Used by the top tab bar inside an electron drag region
   *  so dragging the button doesn't initiate a window drag. */
  noElectronDrag?: boolean;
}

const TRIGGER_CLASS_PILL =
  'w-6 h-6 flex items-center justify-center rounded-md bg-surface hover:bg-app-hover text-app-text-muted hover:text-app-text transition-colors';

/** Estimated menu dimensions for viewport overflow math. The actual menu
 *  is content-sized (`min-w-[150px]`) and item-row height is ~28 px desktop
 *  / ~44 px mobile. Slightly over-estimating is fine — we just want to
 *  decide whether to flip ABOVE the trigger or render BELOW. */
const ESTIMATED_MENU_WIDTH_PX = 180;
const ESTIMATED_MENU_HEIGHT_PX = 220;

export function PaneAddMenu({
  onNewChat,
  onAddPane,
  availableTypes,
  showShortcuts,
  showProjectActions,
  triggerTitle = 'Add pane',
  triggerVariant = 'pill',
  triggerClassName = '',
  noElectronDrag,
}: PaneAddMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number } | null>(null);
  const { isMobile } = useMobile();

  const close = useCallback(() => setOpen(false), []);

  // Outside-click + Escape close.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        e.stopPropagation();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Re-anchor on viewport resize while open.
  useEffect(() => {
    if (!open || isMobile) return;
    const onResize = () => {
      if (!buttonRef.current) return;
      setAnchorRect(computeAnchor(buttonRef.current));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, isMobile]);

  const hasMenuItems = !!onNewChat || (availableTypes && availableTypes.length > 0);
  if (!hasMenuItems) return null;

  /* ── Click handler — Electron overlay path first, web portal fallback ── */
  const handleClick = async () => {
    const overlayApi = window.electronAPI?.overlay;
    const hasNativeBrowser = !!window.electronAPI?.browserNative?.isAvailable;
    if (overlayApi && hasNativeBrowser && buttonRef.current && !open) {
      const selectedId = await openElectronOverlayMenu({
        anchor: buttonRef.current.getBoundingClientRect(),
        onNewChat,
        onAddPane,
        availableTypes,
        showProjectActions,
      });
      if (!selectedId) return;
      dispatchOverlaySelection(selectedId, onNewChat, onAddPane);
      return;
    }
    // Web fallback: anchor + open (or close on second click).
    if (!open && buttonRef.current) {
      setAnchorRect(computeAnchor(buttonRef.current));
    }
    setOpen((prev) => !prev);
  };

  // Trigger preset selection. The 'ghost' variant matches sidebar
  // header icons (Settings, Remote, etc.) — same 7×7 / 10×10 footprint,
  // transparent at rest, hover bg-black/5. The 'pill' variant matches
  // tab-bar / sidebar-project-row affordances — 6×6 with bg-surface.
  // Inner icon size scales with the variant + isMobile to look right.
  const triggerBase =
    triggerVariant === 'ghost'
      ? `${isMobile ? 'w-10 h-10' : 'w-7 h-7'} flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0`
      : TRIGGER_CLASS_PILL;
  const triggerIconSize = triggerVariant === 'ghost' && isMobile ? 18 : 14;

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleClick}
        className={`${triggerBase} ${noElectronDrag ? 'app-no-drag' : ''} ${triggerClassName}`}
        title={triggerTitle}
        style={noElectronDrag ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        data-testid="pane-add-menu-trigger"
      >
        <Plus size={triggerIconSize} />
      </button>
      {open && (isMobile || anchorRect) && createPortal(
        <>
          {isMobile && <div className="fixed inset-0 z-[9998]" onClick={close} />}
          <div
            ref={menuRef}
            className={
              isMobile
                ? 'fixed bottom-0 left-0 right-0 bg-surface border-t border-app-border rounded-t-xl shadow-lg py-2 z-[9999] bottom-sheet'
                : 'fixed bg-surface border border-app-border rounded-lg shadow-lg py-1 z-[9999] min-w-[150px]'
            }
            style={
              isMobile
                ? { paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)' }
                : { top: anchorRect!.top, left: anchorRect!.left }
            }
            data-testid="pane-add-menu"
          >
            <PaneAddMenuItems
              onNewChat={onNewChat}
              onAddPane={onAddPane}
              availableTypes={availableTypes}
              showShortcuts={showShortcuts}
              showProjectActions={showProjectActions}
              onClose={close}
            />
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

function computeAnchor(button: HTMLButtonElement): { top: number; left: number } {
  const rect = button.getBoundingClientRect();
  // Clamp left so the menu never overflows the right edge.
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - ESTIMATED_MENU_WIDTH_PX - 8));
  // Flip above the button if it would clip the bottom of the viewport.
  const fitsBelow = rect.bottom + 4 + ESTIMATED_MENU_HEIGHT_PX <= window.innerHeight - 8;
  const top = fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - ESTIMATED_MENU_HEIGHT_PX - 4);
  return { top, left };
}

interface OverlayMenuItem {
  id: string;
  label: string;
  iconName?: OverlayIconName;
  /** Optional brand accent for the icon. Mirrors `PANE_CONFIG[type].color`
   *  so the Electron overlay paints the same hue as the web menu. The
   *  overlay-renderer ignores it if absent. */
  iconColor?: string;
  divider?: boolean;
}

async function openElectronOverlayMenu({
  anchor,
  onNewChat,
  onAddPane: _onAddPane,
  availableTypes,
  showProjectActions,
}: {
  anchor: DOMRect;
  onNewChat?: () => void;
  onAddPane?: (type: PaneType, subType?: string) => void;
  availableTypes?: readonly PaneType[];
  showProjectActions?: boolean;
}): Promise<string | null> {
  const overlayApi = window.electronAPI?.overlay;
  if (!overlayApi) return null;

  const items: OverlayMenuItem[] = [];
  // Match the web menu's brand-tinted icons by passing `iconColor` to the
  // overlay. Without this Claude Code shows the Anthropic glyph but in
  // mono ink, Shell stays grey instead of terminal-purple, etc. — which is
  // the divergence the user kept seeing between the sidebar (overlay path
  // when a WebContentsView browser is open) and the tab bar (web portal).
  const chatCfg = getPaneConfig('chat');
  if (onNewChat) {
    items.push({
      id: 'new-chat',
      label: 'New Chat',
      iconName: 'message-square',
      iconColor: chatCfg.color,
    });
  }
  for (const type of availableTypes ?? []) {
    if (type === 'terminal') {
      const terminalCfg = getPaneConfig('terminal');
      // Shell uses the boxed terminal-square (matches web <TerminalSquare/>)
      // and the terminal-family purple. Claude Code gets the actual
      // Anthropic glyph (`claude`) in Claude orange — same as the web
      // <ClaudeIcon className="text-[#D97757]" />.
      items.push({
        id: 'terminal-shell',
        label: 'Shell',
        iconName: 'terminal-square',
        iconColor: terminalCfg.color,
        divider: items.length > 0,
      });
      items.push({
        id: 'terminal-claude-code',
        label: 'Claude Code',
        iconName: 'claude',
        iconColor: '#D97757',
      });
    } else {
      const cfg = getPaneConfig(type);
      const iconName = OVERLAY_ICON_BY_LUCIDE[cfg.icon] ?? 'plus-square';
      items.push({
        id: type,
        label: cfg.label,
        iconName,
        // PANE_CONFIG.color is the canonical brand accent per pane type:
        // browser → green, git → red, files → amber, board-memory → green.
        // Same value the web menu reads via getPaneConfig(type).color.
        iconColor: cfg.color,
        divider: type !== availableTypes?.[0] && availableTypes?.[0] !== 'terminal',
      });
    }
  }

  // Open / create a PROJECT — only in global/standalone menus, never inside a
  // project's "+". Distinct icons: folder (open existing) vs plus-square (new).
  if (showProjectActions) {
    items.push({ id: 'open-project', label: 'Apri Progetto', iconName: 'folder', divider: items.length > 0 });
    items.push({ id: 'create-project', label: 'Crea Progetto', iconName: 'plus-square' });
  }

  const isDark = document.documentElement.classList.contains('dark');
  const cs = getComputedStyle(document.documentElement);
  const cssVar = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  const colors = {
    bg: cssVar('--bg-surface', isDark ? '#1f2937' : '#ffffff'),
    text: cssVar('--text', isDark ? '#e5e7eb' : '#1a1a1a'),
    muted: cssVar('--text-muted', isDark ? '#9ca3af' : '#6b7280'),
    border: cssVar('--border', isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'),
    hover: cssVar('--bg-hover', isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'),
  };
  return overlayApi.showMenu({
    anchor: { x: anchor.left, y: anchor.top, width: anchor.width, height: anchor.height },
    items,
    side: 'bottom',
    theme: isDark ? 'dark' : 'light',
    estimatedWidth: ESTIMATED_MENU_WIDTH_PX,
    estimatedItemHeight: 28,
    gap: 4,
    colors,
  });
}

function dispatchOverlaySelection(
  selectedId: string,
  onNewChat?: () => void,
  onAddPane?: (type: PaneType, subType?: string) => void,
): void {
  if (selectedId === 'new-chat') return onNewChat?.();
  if (selectedId === 'terminal-shell') return onAddPane?.('terminal', 'shell');
  if (selectedId === 'terminal-claude-code') return onAddPane?.('terminal', 'claude-code');
  if (selectedId === 'open-project' || selectedId === 'create-project') return openProjectPicker();
  return onAddPane?.(selectedId as PaneType);
}
