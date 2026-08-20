import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Clock, Code2, CornerUpLeft, MoreHorizontal, MonitorSmartphone, Trash2 } from 'lucide-react';
import { AgentActivityPill } from './AgentActivityPill';
import { BrowserFavicon } from './BrowserFavicon';
import { ZoomControl, DeviceSwitcher, ConsoleBadge } from './BrowserDevControls';
import { DownloadsMenu, type DownloadsMenuProps } from './DownloadsMenu';
import type { DeviceMode, BrowserConsoleEntry, NavHistoryEntry } from './browserDevTypes';
import { POPOVER_ITEM, POPOVER_ITEM_DANGER, POPOVER_DIVIDER } from '../../lib/popoverStyles';
import { toNavigableUrl, displayUrl } from '../../lib/browserNavUrl';
import type { ShareMode } from '../../lib/sharedAuto';
import { DropdownPortal } from '../Shared/DropdownPortal';
import { Menu } from '../Shared/Menu';
import { openExternalOnce } from '../../lib/openExternal';
import { useMobile } from '../../hooks/useMobile';
import { useLongPress, type LongPressBinding } from '../../hooks/useLongPress';
import { useT } from '../../hooks/useT';

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
  /** Current zoom percentage (source of truth for the label; keeps button and
   *  keyboard zoom in sync). Defaults to 100 when the host doesn't track it. */
  zoom?: number;
  /** Device-emulation mode + setter. When both present, renders the switcher. */
  deviceMode?: DeviceMode;
  onSetDevice?: (mode: DeviceMode, custom?: { width: number; height: number }) => void;
  /** Quick-console data + clear. When present, renders the error/warning badge. */
  consoleEntries?: BrowserConsoleEntry[];
  consoleSummary?: { errors: number; warnings: number };
  onClearConsole?: () => void;
  /** Download della pane: l'elenco + le sue azioni, così come li vuole
   *  `DownloadsMenu`. Le due pane li riempiono da sorgenti diverse (coda Rust
   *  per quella nativa, messaggi WS per quella condivisa) e il menu è lo stesso. */
  downloads?: DownloadsMenuProps;
  /** Back/forward history (Chrome-style right-click / long-press menu). */
  getNavEntries?: () => Promise<{ entries: NavHistoryEntry[]; activeIndex: number }>;
  onGoToNavIndex?: (index: number) => void;
  /** SHARE control (Tauri only). When `onToggleShare` is defined, renders a
   *  monitor/phone button that cycles this pane's share mode. `shared` is the
   *  EFFECTIVE render (true = streaming the shared server session a phone/web
   *  viewer sees LIVE; false = private native WKWebView). `shareMode` is the
   *  user's choice: 'auto' (native solo, shared when another device views the
   *  same context — the default), or a pinned 'native'/'shared'. Undefined on the
   *  web (the pane is always the shared session — nothing to toggle). */
  shared?: boolean;
  shareMode?: ShareMode;
  onToggleShare?: () => void;
  /** «Dimentica questo sito» (solo pane nativa, e solo su una pagina vera).
   *  La toolbar non cancella niente: apre il dialogo che ELENCA cosa sparisce,
   *  e quello vive nella pane, che sopravvive alla chiusura del popover. */
  onForgetSite?: () => void;
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
  zoom,
  deviceMode,
  onSetDevice,
  consoleEntries,
  consoleSummary,
  onClearConsole,
  downloads,
  getNavEntries,
  onGoToNavIndex,
  shared,
  shareMode,
  onToggleShare,
  onForgetSite,
}: BrowserToolbarProps) {
  const tr = useT();
  const [editUrl, setEditUrl] = useState(url);
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
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
  const backBtnRef = useRef<HTMLButtonElement>(null);
  const forwardBtnRef = useRef<HTMLButtonElement>(null);
  const mousePressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mousePressFiredRef = useRef(false);
  const openNavMenu = useCallback(async (side: 'back' | 'forward') => {
    if (!getNavEntries) return;
    const { entries, activeIndex } = await getNavEntries();
    const filtered = side === 'back'
      ? entries.filter(e => e.index < activeIndex).reverse()
      : entries.filter(e => e.index > activeIndex);
    if (filtered.length === 0) return;
    // React <Menu> popover (portal + flip/clamp + Escape/keyboard) — renders
    // above the native WKWebView pane via Menu's glass-surface occlusion marker.
    setNavMenu({ side, entries, activeIndex });
  }, [getNavEntries]);

  // IL «TIENI PREMUTO» COL DITO ORA ESISTE DAVVERO.
  //
  // Il gesto era armato su `onMouseDown` e disarmato su `onMouseUp`/`onMouseLeave`:
  // col mouse funziona, col dito no. Su iOS quei due eventi sono SINTETIZZATI
  // insieme al `touchend`, quindi il timer nasceva e moriva nello stesso tick e la
  // cronologia Indietro/Avanti era irraggiungibile — mentre il `title` del bottone
  // continuava a prometterla («tieni premuto per la cronologia»).
  // Il ramo touch passa ora dalla primitiva condivisa (slop, `touchcancel`, clic
  // successivo mangiato, feedback `data-pressing`).
  //
  // I DUE RAMI NON SI ESCLUDONO, E SPEGNERE QUELLO MOUSE «SU TOUCH» ERA IL
  // DIFETTO DI PRIMA SPOSTATO DI POPOLAZIONE. I gestori mouse erano
  // `isTouch ? undefined : …`: su un portatile con schermo touch — dove `isTouch`
  // è vero E il mouse c'è — la cronologia Indietro/Avanti tornava raggiungibile
  // SOLO col tasto destro, cioè esattamente ciò che questo blocco dichiara di
  // aver chiuso. Ora ogni ramo si arma sulla propria domanda: i gestori MOUSE su
  // `hasHover` (c'è un puntatore), quelli TOUCH su `isTouch` (si può toccare).
  // Su un ibrido ci sono entrambi e non litigano: sono eventi diversi, e i due
  // timer sono separati (`mousePressRef` / quello interno alla primitiva) — un
  // tocco non sintetizza `mousedown` prima del `touchend`, quindi non si sommano.
  const { isTouch, hasHover } = useMobile();
  const canNavMenu = !!getNavEntries;
  const backLongPress = useLongPress(() => { void openNavMenu('back'); }, { enabled: isTouch && canNavMenu });
  const forwardLongPress = useLongPress(() => { void openNavMenu('forward'); }, { enabled: isTouch && canNavMenu });
  // Un timer armato non deve sopravvivere alla toolbar che lo ha armato: una
  // pane browser chiusa mentre tieni premuto aprirebbe la cronologia di una
  // webview che non c'è più. (La primitiva lo fa già per il ramo touch.)
  useEffect(() => () => { if (mousePressRef.current) clearTimeout(mousePressRef.current); }, []);

  const navButtonHandlers = (side: 'back' | 'forward', navFn: () => void, lp: LongPressBinding) => ({
    ...lp.handlers,
    onClick: () => {
      // Il clic che il browser sintetizza DOPO un long-press andato a segno non
      // deve anche navigare: aprirebbe la cronologia e poi se ne andrebbe.
      if (lp.consumeClick()) return;
      if (mousePressFiredRef.current) { mousePressFiredRef.current = false; return; }
      navFn();
    },
    onContextMenu: (e: React.MouseEvent) => { if (!canNavMenu) return; e.preventDefault(); void openNavMenu(side); },
    onMouseDown: hasHover ? () => {
      if (!canNavMenu) return;
      mousePressFiredRef.current = false;
      mousePressRef.current = setTimeout(() => { mousePressFiredRef.current = true; void openNavMenu(side); }, 450);
    } : undefined,
    onMouseUp: hasHover ? () => { if (mousePressRef.current) { clearTimeout(mousePressRef.current); mousePressRef.current = null; } } : undefined,
    onMouseLeave: hasHover ? () => { if (mousePressRef.current) { clearTimeout(mousePressRef.current); mousePressRef.current = null; } } : undefined,
  });

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

  const handleSubmit = useCallback((e: React.SubmitEvent) => {
    e.preventDefault();
    // An omnibox: a bare host becomes https://, and anything that isn't a URL
    // (spaces, no dot) becomes a web search. The old code force-prepended
    // `http://` to any scheme-less text, which turned "come fare la pasta" into
    // a broken `http://come fare la pasta` nav and downgraded bare hosts to
    // http. normalizeUrl is the single source of truth, shared with the hook's
    // navigate() so the two never disagree.
    if (!editUrl.trim()) return;
    // `toNavigableUrl` prima di `normalizeUrl` (che chiama dentro): la barra
    // mostra `file:///Users/…` per un file locale, e premere Invio su quella
    // riga deve riportare allo stesso documento — servito, non aperto dal disco.
    onUrlChange(toNavigableUrl(editUrl));
    setEditing(false);
  }, [editUrl, onUrlChange]);

  const handleOpenExternal = useCallback(() => {
    // Hand the current page to the REAL system browser (Chrome/Safari/…) via the
    // shell bridge — `window.open('_blank')` is a no-op inside the WKWebView pane.
    // This is also the escape hatch for reCAPTCHA-v3-gated / captcha-login sites:
    // the WKWebView is flagged as a bot, so the user finishes the flow in a real,
    // un-flagged browser (with that browser's own session).
    if (url) openExternalOnce(url);
  }, [url]);

  return (
    // `chrome-row-solid` + `h-10`: è una riga di chrome come le altre, e ora lo
    // dice anche il suo fondo. Era `chrome-glass` e basta, cioè sotto la shell
    // mac una tinta decisa da chi la contiene invece che da lei (vedi index.css);
    // e `py-1.5` la faceva alta quanto il suo contenuto, cioè 40 finché i
    // bottoni sono 28 e un altro numero al primo che cambia. L'altezza della
    // riga di chrome è una costante dell'app, non un risultato.
    <div ref={toolbarRef} className="relative flex items-center gap-1 px-2 h-10 flex-shrink-0 chrome-row-solid border-b border-app-border">
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
      {/* Navigation buttons. Right-click / long-press opens the history menu.
          `tap-expand`: il box resta 24px (la toolbar è alta quello che è) e
          cresce solo l'area sensibile, a 44px, e solo su `pointer: coarse` —
          altrimenti il bersaglio è metà della soglia iOS. Le due aree espanse si
          sovrappongono nei 4px di `gap-1` fra i bottoni, e lì vince chi viene
          dopo nel DOM: il confine fra Indietro e Avanti cade qualche pixel dentro
          al glifo di Indietro. È il prezzo di due bersagli da 44 distanti 28, ed
          è comunque meglio di due da 24 che un dito manca. */}
      <button
        ref={backBtnRef}
        {...navButtonHandlers('back', onBack, backLongPress)}
        data-pressing={backLongPress.pressed || undefined}
        disabled={!canGoBack}
        className="tap-expand w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary disabled:opacity-30 transition-colors"
        title={getNavEntries ? 'Indietro (tieni premuto per la cronologia)' : 'Indietro'}
      >
        <ArrowLeft size={14} />
      </button>
      <button
        ref={forwardBtnRef}
        {...navButtonHandlers('forward', onForward, forwardLongPress)}
        data-pressing={forwardLongPress.pressed || undefined}
        disabled={!canGoForward}
        className="tap-expand w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary disabled:opacity-30 transition-colors"
        title={getNavEntries ? 'Avanti (tieni premuto per la cronologia)' : 'Avanti'}
      >
        <ArrowRight size={14} />
      </button>

      {/* Back/forward history menu — anchored React <Menu> (portal, flip/clamp,
          Escape + roving keyboard nav, focus-restore), rendered above the native
          WKWebView pane via Menu's glass-surface occlusion marker. */}
      <Menu
        open={!!navMenu}
        anchorRef={navMenu?.side === 'forward' ? forwardBtnRef : backBtnRef}
        onClose={() => setNavMenu(null)}
        align="left"
        minWidth={260}
        className="max-w-[460px]"
      >
        {navMenu && (() => {
          const items = navMenu.side === 'back'
            ? navMenu.entries.filter(e => e.index < navMenu.activeIndex).reverse()
            : navMenu.entries.filter(e => e.index > navMenu.activeIndex);
          if (items.length === 0) {
            return <div className="px-3 py-1.5 text-[11px] text-app-text-faint">{tr('browser.nav.empty')}</div>;
          }
          return (
            <div data-testid="browser-nav-history-menu">
              {items.map((e) => (
                <button key={e.index} type="button"
                  onClick={() => { onGoToNavIndex?.(e.index); setNavMenu(null); }}
                  className="w-full px-3 py-1.5 text-left hover:bg-app-hover"
                  title={e.url}>
                  <div className="text-[12px] text-app-text truncate">{e.title || e.url}</div>
                  <div className="text-[10px] text-app-text-faint truncate">{e.url}</div>
                </button>
              ))}
            </div>
          );
        })()}
      </Menu>
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
          title={spawnerLabel ? tr('browser.spawner.titleNamed', { name: spawnerLabel }) : tr('browser.spawner.title')}
          aria-label={tr('browser.spawner.aria')}
          data-testid="browser-back-to-spawner"
        >
          <CornerUpLeft size={14} />
        </button>
      )}

      {/* URL bar. When idle, the raw input text is hidden and a Chrome-style
          pretty overlay (host emphasized, scheme/path muted) is painted on top;
          the overlay is pointer-events:none so a click falls through to focus
          the input for editing.

          L'icona a sinistra è uno SLOT di larghezza fissa (BrowserFavicon): c'è
          sempre, con la favicon del sito o col segnaposto, quindi il testo
          dell'indirizzo comincia sempre allo stesso pixel invece di scivolare
          di 18px quando l'icona finisce di caricare. */}
      <form onSubmit={handleSubmit} className="flex-1 min-w-[80px]">
        <div className="relative flex items-center">
          <BrowserFavicon
            url={url}
            faviconUrl={faviconUrl}
            className="absolute left-2 pointer-events-none"
          />
          {(() => {
            const padL = 'pl-7';
            const leftClass = 'left-7';
            const showPretty = !editing && !!urlParts;
            return (
              <>
                <input
                  ref={urlInputRef}
                  type="text"
                  value={editing ? editUrl : displayUrl(url)}
                  onChange={(e) => { setEditUrl(e.target.value); setEditing(true); }}
                  onFocus={() => { setEditUrl(displayUrl(url)); setEditing(true); }}
                  onBlur={() => { setTimeout(() => setEditing(false), 200); }}
                  placeholder={tr('browser.url.placeholder')}
                  spellCheck={false}
                  data-testid="browser-url-input"
                  className={`w-full ${padL} pr-2 py-1 text-[12px] rounded-md border border-transparent bg-transparent hover:bg-black/5 dark:hover:bg-white/5 focus:bg-transparent focus:border-app-border-input focus:outline-none text-app-text-heading placeholder-app-text-faint transition-colors ${showPretty ? 'text-transparent caret-transparent' : ''}`}
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
      {/* Download — inline a ogni larghezza, come il badge della console: il suo
          menu si ancora al proprio bottone, e piegato dentro l'overflow si
          ancorerebbe alla voce di un altro popover. Il bottone esiste solo
          quando c'è almeno un download, quindi a riposo non toglie niente. */}
      {downloads && <DownloadsMenu {...downloads} />}
      {deviceMode && onSetDevice && (
        <DeviceSwitcher mode={deviceMode} onSet={onSetDevice} />
      )}
      {onZoom && <ZoomControl zoom={zoom} onZoom={onZoom} />}

      {/* Overflow "⋯" menu. Compact panes fold the SECONDARY actions (history /
          DevTools / open-external) in here so the URL bar keeps its width. The
          session switch (Tauri only) lives here at EVERY width — it's a rare,
          deliberate action (leave the shared server session for the private
          native browser), not a primary toolbar button. So the menu renders
          whenever the pane is compact OR there's a session switch to host. */}
      {(compact || !!onToggleShare || !!onForgetSite) && (
        <>
          <button
            ref={overflowBtnRef}
            type="button"
            onClick={() => setOverflowOpen((o) => !o)}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors shrink-0"
            title={tr('browser.toolbar.more')}
            data-testid="browser-toolbar-overflow"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
          >
            <MoreHorizontal size={14} />
          </button>
          <DropdownPortal
            open={overflowOpen}
            anchorRef={overflowBtnRef}
            onClose={() => setOverflowOpen(false)}
            align="right"
          >
            {/* Sessione di QUESTO device: automatica (default) → nativa privata →
                server condivisa → automatica. NON è "condivisione con altri utenti"
                (quella è per-chat/progetto, task d6baaf5e). L'automatica va nativa e
                veloce da solo, e si condivide da sé quando un altro tuo device apre
                la stessa tab. Un clic FISSA lo stato successivo del ciclo. */}
            {onToggleShare && (() => {
              const m: ShareMode = shareMode ?? (shared ? 'shared' : 'native');
              const label = m === 'auto' ? 'Sessione: automatica' : m === 'shared' ? 'Sessione: condivisa' : 'Sessione: nativa (privata)';
              const title = m === 'auto'
                ? 'Automatica: nativa e veloce da solo, si condivide da sé quando un altro tuo device apre la stessa tab. Clic → fissa NATIVA.'
                : m === 'shared'
                ? 'Condivisa: sessione server, la vedono telefono/agenti (più lenta). Clic → AUTOMATICA.'
                : 'Nativa: browser privato di questo Mac, veloce. Clic → fissa CONDIVISA.';
              const dot = shared ? 'text-green-600 dark:text-green-400' : m === 'auto' ? 'text-app-text-secondary' : 'text-app-text-tertiary';
              return (
                <>
                  <button
                    type="button"
                    onClick={() => { onToggleShare(); setOverflowOpen(false); }}
                    className={POPOVER_ITEM}
                    data-testid="browser-share-toggle"
                    data-share-mode={m}
                    aria-pressed={!!shared}
                    title={title}
                  >
                    <MonitorSmartphone size={13} className={`shrink-0 ${dot}`} />
                    {label}
                  </button>
                  {compact && <div className={POPOVER_DIVIDER} />}
                </>
              );
            })()}
            {compact && (
              <>
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
                  <ExternalLink size={13} className="shrink-0 text-app-text-tertiary" /> {tr('browser.openSystem')}
                </button>
              </>
            )}
            {/* Dimentica questo sito. Ultima voce e separata dal resto: è
                l'unica del menu che distrugge qualcosa. I puntini di sospensione
                sono una promessa, non decorazione: il clic apre l'elenco di cosa
                sparisce, non cancella. */}
            {onForgetSite && (
              <>
                {(compact || !!onToggleShare) && <div className={POPOVER_DIVIDER} />}
                <button
                  type="button"
                  onClick={() => { onForgetSite(); setOverflowOpen(false); }}
                  className={POPOVER_ITEM_DANGER}
                  data-testid="browser-forget-site"
                  title={urlParts
                    ? tr('browser.forget.titleHost', { host: urlParts.host })
                    : tr('browser.forget.title')}
                >
                  <Trash2 size={13} className="shrink-0" /> {tr('browser.forget.label')}
                </button>
              </>
            )}
          </DropdownPortal>
        </>
      )}

      {!compact && (
        <>
          {/* Phase 30 BROWSER-CHAT-04 — URL history dropdown (per-topic, last 10) */}
          {history && history.length > 0 && (
            <>
              <button
                ref={historyBtnRef}
                type="button"
                onClick={() => setHistoryOpen((open) => !open)}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-secondary transition-colors"
                title="Recent URLs"
                data-testid="browser-history-button"
              >
                <Clock size={14} />
              </button>
              <Menu
                open={historyOpen}
                anchorRef={historyBtnRef}
                onClose={() => setHistoryOpen(false)}
                align="right"
                minWidth={260}
                className="max-w-[480px]"
              >
                <div data-testid="browser-history-menu">
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
              </Menu>
            </>
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
            title={tr('browser.openSystem.hint')}
          >
            <ExternalLink size={14} />
          </button>
        </>
      )}
    </div>
  );
}
