import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Clock, Code2, CornerUpLeft, MoreHorizontal } from 'lucide-react';
import { AgentActivityPill } from './AgentActivityPill';
import { ZoomControl, DeviceSwitcher, ConsoleBadge } from './BrowserDevControls';
import type { DeviceMode, BrowserConsoleEntry, NavHistoryEntry } from './browserDevTypes';
import { overlayMenusAvailable, showOverlayMenu } from '../../lib/overlayMenu';
import { POPOVER_SURFACE, POPOVER_ITEM, POPOVER_DIVIDER } from '../../lib/popoverStyles';
import { DropdownPortal } from '../Shared/DropdownPortal';

/** Split a URL into scheme / host / rest for Chrome-style emphasis (host bold,
 *  the rest muted). Falls back to the raw string for non-URLs (about:blank,
 *  data:, file paths). https:// is hidden like Chrome; other schemes are shown. */
function splitUrlParts(raw: string): { scheme: string; host: string; rest: string } | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.hostname) return null;
    const scheme = u.protocol === 'https:' ? '' : `${u.protocol}//`;
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
    return { scheme, host: u.hostname.replace(/^www\./, ''), rest };
  } catch {
    return null;
  }
}

interface BrowserToolbarProps {
  url: string;
  onUrlChange: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** Phase 30 BROWSER-CHAT-04 — recent URLs dropdown (per-topic history). */
  history?: string[];
  /** Phase 30.1 polish — DevTools toggle for native WebContentsView. Hidden in web mode (undefined). */
  onToggleDevTools?: () => void;
  /** Phase 30.1 polish — favicon URL emitted by Chromium. Empty during navigation. */
  faviconUrl?: string;
  /** Phase 30.1 polish — register a focus-the-URL-bar callback. Cmd+L wires here. */
  onRegisterFocus?: (focusFn: () => void) => void;
  /** Reciprocal of ChatPanel's jump-to-browser button. When this browser was
   *  spawned from a chat (tracked via `browserSpawner` registry), the wrapper
   *  passes a callback that focuses the spawning chat pane. Renders a small
   *  back-arrow chip on the left of the URL bar — hidden when undefined. */
  onBackToSpawner?: () => void;
  /** Optional label shown in the tooltip (e.g. the spawner chat name) so the
   *  user knows where the back button will take them without guessing. */
  spawnerLabel?: string;
  /** True while the agent is driving this browser (agent_active broadcast).
   *  Surfaces a non-blocking "agent at work" pill — no page reflow. */
  agentActive?: boolean;
  /** Human-readable label of the agent's current action ("Clicca", …). */
  agentAction?: string | null;
  // --- Native dev controls (Electron only; omitted in web/screenshot mode) ---
  /** Zoom (returns the new zoom level). When present, renders the zoom control. */
  onZoom?: (delta: number | 'reset') => Promise<number>;
  /** Device-emulation mode + setter. When both present, renders the switcher. */
  deviceMode?: DeviceMode;
  onSetDevice?: (mode: DeviceMode, custom?: { width: number; height: number }) => void;
  /** Quick-console data + clear. When present, renders the error/warning badge. */
  consoleEntries?: BrowserConsoleEntry[];
  consoleSummary?: { errors: number; warnings: number };
  onClearConsole?: () => void;
  /** Back/forward history (Chrome-style right-click / long-press menu). */
  getNavEntries?: () => Promise<{ entries: NavHistoryEntry[]; activeIndex: number }>;
  onGoToNavIndex?: (index: number) => void;
}

export function BrowserToolbar({
  url,
  onUrlChange,
  onBack,
  onForward,
  onRefresh,
  canGoBack,
  canGoForward,
  loading,
  history,
  onToggleDevTools,
  faviconUrl,
  onRegisterFocus,
  onBackToSpawner,
  spawnerLabel,
  agentActive,
  agentAction,
  onZoom,
  deviceMode,
  onSetDevice,
  consoleEntries,
  consoleSummary,
  onClearConsole,
  getNavEntries,
  onGoToNavIndex,
}: BrowserToolbarProps) {
  const [editUrl, setEditUrl] = useState(url);
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [faviconError, setFaviconError] = useState(false);
  const urlParts = useMemo(() => splitUrlParts(url), [url]);

  // Responsiveness — when the pane is squeezed narrow, the trailing controls
  // (dev tools, history, zoom, …) crowd out the URL bar. A ResizeObserver on
  // the toolbar root flips a single `compact` breakpoint (~420px); below it the
  // trailing cluster collapses into one overflow "⋯" menu so the URL field
  // keeps a legible min-width. Essential nav (back/forward/refresh/URL) always
  // stays inline.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setCompact(w < 420);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Back/forward navigation-history menu (Chrome-style right-click / long-press).
  const [navMenu, setNavMenu] = useState<{ side: 'back' | 'forward'; entries: NavHistoryEntry[]; activeIndex: number } | null>(null);
  const navMenuRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const openNavMenu = useCallback(async (side: 'back' | 'forward', anchorEl: HTMLElement | null) => {
    if (!getNavEntries) return;
    const { entries, activeIndex } = await getNavEntries();
    const filtered = side === 'back'
      ? entries.filter(e => e.index < activeIndex).reverse()
      : entries.filter(e => e.index > activeIndex);
    if (filtered.length === 0) return;
    // Native menu above the OS-level WebContentsView (Electron); React dropdown
    // is the web/screenshot fallback.
    if (overlayMenusAvailable()) {
      const id = await showOverlayMenu({
        anchorEl,
        items: filtered.map(e => ({ id: String(e.index), label: e.title || e.url })),
        side: 'bottom',
        estimatedWidth: 340,
      });
      if (id != null) onGoToNavIndex?.(Number(id));
      return;
    }
    setNavMenu({ side, entries, activeIndex });
  }, [getNavEntries, onGoToNavIndex]);
  useEffect(() => {
    if (!navMenu) return;
    const h = (e: MouseEvent) => { if (navMenuRef.current && !navMenuRef.current.contains(e.target as Node)) setNavMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [navMenu]);
  const navButtonHandlers = (side: 'back' | 'forward', navFn: () => void) => ({
    onClick: () => { if (longPressFiredRef.current) { longPressFiredRef.current = false; return; } navFn(); },
    onContextMenu: (e: React.MouseEvent) => { if (!getNavEntries) return; e.preventDefault(); void openNavMenu(side, e.currentTarget as HTMLElement); },
    onMouseDown: (e: React.MouseEvent) => {
      if (!getNavEntries) return;
      longPressFiredRef.current = false;
      const anchorEl = e.currentTarget as HTMLElement;
      longPressRef.current = setTimeout(() => { longPressFiredRef.current = true; void openNavMenu(side, anchorEl); }, 450);
    },
    onMouseUp: () => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } },
    onMouseLeave: () => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } },
  });

  // Reset favicon error state when URL changes (new favicon may load).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local error flag to the faviconUrl prop; resets to a constant so it converges immediately and can't loop (faviconUrl is not derived from this state)
  useEffect(() => { setFaviconError(false); }, [faviconUrl]);

  // Phase 30.1 polish — register focus-bar callback so Cmd+L can focus
  // the URL input even when the panel itself isn't focused.
  useEffect(() => {
    if (!onRegisterFocus) return;
    onRegisterFocus(() => {
      const el = urlInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
  }, [onRegisterFocus]);

  // Close history dropdown on outside click.
  useEffect(() => {
    if (!historyOpen) return;
    const handler = (e: MouseEvent) => {
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [historyOpen]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    let finalUrl = editUrl.trim();
    if (finalUrl && !finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      finalUrl = 'http://' + finalUrl;
    }
    if (finalUrl) {
      onUrlChange(finalUrl);
      setEditing(false);
    }
  }, [editUrl, onUrlChange]);

  const handleOpenExternal = useCallback(() => {
    if (url) {
      window.open(url, '_blank');
    }
  }, [url]);

  return (
    <div ref={toolbarRef} className="relative flex items-center gap-1 px-2 py-1.5 glass-surface border-b border-app-border">
      {/* Phase 30.1 polish — Chrome-style indeterminate progress bar at the
          bottom of the toolbar while loading. Inline keyframes + minimal
          DOM (single absolutely-positioned bar, ~3 LOC). */}
      {loading && (
        <>
          <style>{`
            @keyframes browser-toolbar-progress {
              0%   { transform: translateX(-100%) scaleX(0.4); }
              50%  { transform: translateX(0%)    scaleX(0.6); }
              100% { transform: translateX(100%)  scaleX(0.2); }
            }
            .browser-toolbar-progress-bar {
              animation: browser-toolbar-progress 1.4s linear infinite;
              transform-origin: left;
            }
          `}</style>
          <div
            className="absolute left-0 right-0 bottom-0 h-[2px] overflow-hidden pointer-events-none"
            data-testid="browser-toolbar-progress"
            aria-hidden
          >
            <div className="browser-toolbar-progress-bar absolute inset-0 bg-primary" />
          </div>
        </>
      )}
      {/* Navigation buttons. Right-click / long-press opens the history menu. */}
      <button
        {...navButtonHandlers('back', onBack)}
        disabled={!canGoBack}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary disabled:opacity-30 transition-colors"
        title={getNavEntries ? 'Indietro (tieni premuto per la cronologia)' : 'Indietro'}
      >
        <ArrowLeft size={14} />
      </button>
      <button
        {...navButtonHandlers('forward', onForward)}
        disabled={!canGoForward}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary disabled:opacity-30 transition-colors"
        title={getNavEntries ? 'Avanti (tieni premuto per la cronologia)' : 'Avanti'}
      >
        <ArrowRight size={14} />
      </button>

      {/* Back/forward history menu */}
      {navMenu && (
        <div
          ref={navMenuRef}
          className={`absolute top-full left-2 mt-1 z-50 min-w-[260px] max-w-[460px] ${POPOVER_SURFACE}`}
          data-testid="browser-nav-history-menu"
        >
          {(() => {
            const items = navMenu.side === 'back'
              ? navMenu.entries.filter(e => e.index < navMenu.activeIndex).reverse()
              : navMenu.entries.filter(e => e.index > navMenu.activeIndex);
            if (items.length === 0) {
              return <div className="px-3 py-1.5 text-[11px] text-app-text-faint">Nessuna voce</div>;
            }
            return items.map((e) => (
              <button key={e.index} type="button"
                onClick={() => { onGoToNavIndex?.(e.index); setNavMenu(null); }}
                className="w-full px-3 py-1.5 text-left hover:bg-app-hover"
                title={e.url}>
                <div className="text-[12px] text-app-text truncate">{e.title || e.url}</div>
                <div className="text-[10px] text-app-text-faint truncate">{e.url}</div>
              </button>
            ));
          })()}
        </div>
      )}
      <button
        onClick={onRefresh}
        className={`w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors ${loading ? 'animate-spin' : ''}`}
        title="Refresh"
      >
        <RotateCw size={14} />
      </button>

      {/* Back-to-spawner — surfaces only when this browser was opened from a
          chat (the spawner registry has a mapping). Sits just before the URL
          bar so it visually pairs with the favicon, making the affordance
          read as "where this page came from". */}
      {onBackToSpawner && (
        <button
          type="button"
          onClick={onBackToSpawner}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-primary/15 text-app-text-secondary hover:text-primary transition-colors"
          title={spawnerLabel ? `Torna alla chat "${spawnerLabel}"` : 'Torna alla chat che ha aperto questo browser'}
          aria-label="Torna alla chat spawner"
          data-testid="browser-back-to-spawner"
        >
          <CornerUpLeft size={14} />
        </button>
      )}

      {/* URL bar. When idle, the raw input text is hidden and a Chrome-style
          pretty overlay (host emphasized, scheme/path muted) is painted on top;
          the overlay is pointer-events:none so a click falls through to focus
          the input for editing. No globe icon — just the favicon when present. */}
      <form onSubmit={handleSubmit} className="flex-1 min-w-[80px]">
        <div className="relative flex items-center">
          {faviconUrl && !faviconError && (
            <img
              src={faviconUrl}
              alt=""
              className="absolute left-2 w-3.5 h-3.5 object-contain pointer-events-none"
              onError={() => setFaviconError(true)}
              data-testid="browser-favicon"
            />
          )}
          {(() => {
            const hasFav = !!(faviconUrl && !faviconError);
            const padL = hasFav ? 'pl-7' : 'pl-2.5';
            const leftClass = hasFav ? 'left-7' : 'left-2.5';
            const showPretty = !editing && !!urlParts;
            return (
              <>
                <input
                  ref={urlInputRef}
                  type="text"
                  value={editing ? editUrl : url}
                  onChange={(e) => { setEditUrl(e.target.value); setEditing(true); }}
                  onFocus={() => { setEditUrl(url); setEditing(true); }}
                  onBlur={() => { setTimeout(() => setEditing(false), 200); }}
                  placeholder="Cerca o inserisci un indirizzo"
                  spellCheck={false}
                  data-testid="browser-url-input"
                  className={`w-full ${padL} pr-2 py-1 text-[12px] rounded-md border border-transparent bg-transparent hover:bg-black/5 dark:hover:bg-white/5 focus:bg-surface dark:focus:bg-elevated focus:border-app-border-input focus:outline-none text-app-text-heading placeholder-app-text-faint transition-colors ${showPretty ? 'text-transparent caret-transparent' : ''}`}
                />
                {showPretty && urlParts && (
                  <div
                    className={`absolute ${leftClass} right-2 py-1 text-[12px] truncate pointer-events-none select-none`}
                    aria-hidden
                    data-testid="browser-url-pretty"
                  >
                    {urlParts.scheme && <span className="text-app-text-faint">{urlParts.scheme}</span>}
                    <span className="text-app-text-heading">{urlParts.host}</span>
                    <span className="text-app-text-faint">{urlParts.rest}</span>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      </form>

      {/* Agent activity — non-blocking pill (no page reflow). Lingers ~700ms. */}
      <AgentActivityPill active={!!agentActive} action={agentAction} />

      {/* Native dev controls (Electron only) — console / device / zoom. Kept
          INLINE at every width: their own surfaces (console panel, device
          presets) anchor correctly only when NOT nested inside another popover,
          so folding them into the overflow made the console menu mis-anchor. */}
      {consoleSummary && consoleEntries && onClearConsole && (
        <ConsoleBadge entries={consoleEntries} summary={consoleSummary} onClear={onClearConsole} />
      )}
      {deviceMode && onSetDevice && (
        <DeviceSwitcher mode={deviceMode} onSet={onSetDevice} />
      )}
      {onZoom && <ZoomControl onZoom={onZoom} />}

      {compact ? (
        /* Narrow pane — only the SECONDARY actions (history / DevTools / open
           external) fold into one overflow "⋯" menu so the URL bar keeps its
           width. Reuses the shared DropdownPortal popover. */
        <>
          <button
            ref={overflowBtnRef}
            type="button"
            onClick={() => setOverflowOpen((o) => !o)}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors shrink-0"
            title="Altri controlli"
            data-testid="browser-toolbar-overflow"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
          >
            <MoreHorizontal size={14} />
          </button>
          <DropdownPortal
            open={compact && overflowOpen}
            anchorRef={overflowBtnRef}
            onClose={() => setOverflowOpen(false)}
            align="right"
          >
            {history && history.length > 0 && (
              <>
                {history.slice(0, 8).map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => { onUrlChange(entry); setOverflowOpen(false); }}
                    className={POPOVER_ITEM}
                    title={entry}
                  >
                    <Clock size={13} className="shrink-0 text-app-text-tertiary" />
                    <span className="truncate">{entry}</span>
                  </button>
                ))}
                <div className={POPOVER_DIVIDER} />
              </>
            )}
            {onToggleDevTools && (
              <button
                type="button"
                onClick={() => { onToggleDevTools(); setOverflowOpen(false); }}
                className={POPOVER_ITEM}
              >
                <Code2 size={13} className="shrink-0 text-app-text-tertiary" /> DevTools
              </button>
            )}
            <button
              type="button"
              onClick={() => { handleOpenExternal(); setOverflowOpen(false); }}
              disabled={!url}
              className={`${POPOVER_ITEM} disabled:opacity-40`}
            >
              <ExternalLink size={13} className="shrink-0 text-app-text-tertiary" /> Apri nel browser
            </button>
          </DropdownPortal>
        </>
      ) : (
        <>
          {/* Phase 30 BROWSER-CHAT-04 — URL history dropdown (per-topic, last 10) */}
          {history && history.length > 0 && (
            <div className="relative" ref={historyMenuRef}>
              <button
                type="button"
                onClick={async (e) => {
                  // Native menu above the WebContentsView (Electron); React dropdown fallback on web.
                  if (overlayMenusAvailable()) {
                    const id = await showOverlayMenu({
                      anchorEl: e.currentTarget,
                      items: history!.slice(0, 10).map((u) => ({ id: u, label: u })),
                      side: 'bottom',
                      estimatedWidth: 380,
                    });
                    if (id != null) onUrlChange(id);
                    return;
                  }
                  setHistoryOpen((open) => !open);
                }}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors"
                title="Recent URLs"
                data-testid="browser-history-button"
              >
                <Clock size={14} />
              </button>
              {historyOpen && (
                <div
                  className={`absolute top-full right-0 mt-1 z-50 min-w-[260px] max-w-[480px] ${POPOVER_SURFACE}`}
                  data-testid="browser-history-menu"
                >
                  {history.slice(0, 10).map((entry) => (
                    <button
                      key={entry}
                      type="button"
                      onClick={() => { onUrlChange(entry); setHistoryOpen(false); }}
                      className="w-full px-3 py-1.5 text-left text-[11px] text-app-text hover:bg-app-hover truncate"
                      title={entry}
                    >
                      {entry}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Phase 30.1 polish — DevTools toggle (Electron native only) */}
          {onToggleDevTools && (
            <button
              onClick={onToggleDevTools}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors"
              title="Toggle DevTools (⌥⌘I)"
              data-testid="browser-devtools-button"
            >
              <Code2 size={14} />
            </button>
          )}

          {/* Open external */}
          <button
            onClick={handleOpenExternal}
            disabled={!url}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary disabled:opacity-30 transition-colors"
            title="Open in browser"
          >
            <ExternalLink size={14} />
          </button>
        </>
      )}
    </div>
  );
}
