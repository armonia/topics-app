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
 *  string keys. Returns `'plus-square'` for any name we don't have. */
type OverlayIconName = 'globe' | 'terminal' | 'message-square' | 'folder' | 'bot' | 'file-text' | 'layout' | 'list' | 'plus-square';
const OVERLAY_ICON_BY_LUCIDE: Record<string, OverlayIconName> = {
  Globe: 'globe',
  Terminal: 'terminal',
  TerminalSquare: 'terminal',
  MessageSquare: 'message-square',
  Folder: 'folder',
  FolderOpen: 'folder',
  Bot: 'bot',
  FileText: 'file-text',
  Layout: 'layout',
  LayoutGrid: 'layout',
  List: 'list',
};

/** Shared row class — identical for every host so the menu looks the same
 *  regardless of which portal renders it. */
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
  /** Show keyboard shortcut hints (e.g. ⌘N next to "New Chat"). True on
   *  the top tab bar (where Cmd+N targets the focused group); false in
   *  the sidebar (where Cmd+N would NOT target this specific project). */
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
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.isElectron;

  const choose = (fn: () => void) => () => {
    fn();
    onClose();
  };

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
  divider?: boolean;
}

async function openElectronOverlayMenu({
  anchor,
  onNewChat,
  onAddPane: _onAddPane,
  availableTypes,
}: {
  anchor: DOMRect;
  onNewChat?: () => void;
  onAddPane?: (type: PaneType, subType?: string) => void;
  availableTypes?: readonly PaneType[];
}): Promise<string | null> {
  const overlayApi = window.electronAPI?.overlay;
  if (!overlayApi) return null;

  const items: OverlayMenuItem[] = [];
  if (onNewChat) items.push({ id: 'new-chat', label: 'New Chat', iconName: 'message-square' });
  for (const type of availableTypes ?? []) {
    if (type === 'terminal') {
      items.push({ id: 'terminal-shell', label: 'Shell', iconName: 'terminal', divider: items.length > 0 });
      items.push({ id: 'terminal-claude-code', label: 'Claude Code', iconName: 'bot' });
    } else {
      const cfg = getPaneConfig(type);
      const iconName = OVERLAY_ICON_BY_LUCIDE[cfg.icon] ?? 'plus-square';
      items.push({
        id: type,
        label: cfg.label,
        iconName,
        divider: type !== availableTypes?.[0] && availableTypes?.[0] !== 'terminal',
      });
    }
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
  return onAddPane?.(selectedId as PaneType);
}
