/**
 * THE TAB SHEET: ONE SURFACE, AND THERE IS NO SECOND ONE.
 *
 * A browser pane used to spread its chrome over three places, and each of them
 * was a place you had to already know about:
 *
 *   - `BrowserToolbar`, a 40px row above the page that came back whenever the
 *     console opened or a download started, i.e. exactly when you were looking
 *     at something else;
 *   - the three-dots MENU on the tab, which held zoom, device, session and
 *     forget-site behind a glyph that is invisible until you hover it;
 *   - the address DROPDOWN, a fourth surface that existed only to type a URL.
 *
 * All three are this file now. A click on the tab you are already in, a click
 * on the three dots, or Cmd+L opens ONE panel that hangs from the tab and holds
 * everything the pane can do, in the order you reach for it: where you are,
 * how to move, where you have been, and then the tools.
 *
 * WHY IT IS NOT A PORTAL, which is what the address dropdown did. A popover
 * portalled out of a container that can close dies on its first click, and the
 * tab is exactly such a container: a pane can be closed, moved to another
 * group, or re-tabbed while its sheet is open. `position: fixed` escapes the
 * `overflow-hidden` of the tab and of the strip on its own - it is only clipped
 * by a TRANSFORMED ancestor, and the tab bar has none - so the sheet stays in
 * the tab's own React subtree and dies with it, which is the correct lifetime.
 *
 * `POPOVER_SURFACE` is not a style choice: it carries `glass-surface`, the
 * class `OVERLAY_SELECTOR` matches (`lib/shell/browserOcclusion`), and that
 * match is what parks the native WKWebView underneath so the sheet is visible
 * at all on the desktop app. The explicit `freeze()` on mount is the other half
 * of the same fact: the watcher only knows once the panel has been measured,
 * while the sheet knows it is covering the page from the first frame.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowLeft, ArrowRight, RotateCw, ExternalLink, Copy, Check, Clock, Compass,
  Code2, Trash2, Minus, Plus, MonitorSmartphone, CornerUpLeft,
  Monitor, Smartphone, Tablet, Maximize,
} from 'lucide-react';
import { BrowserFavicon } from './BrowserFavicon';
import { ConsoleBadge } from './BrowserDevControls';
import { DownloadsMenu } from './DownloadsMenu';
import { useBrowserPaneChrome } from '../../state/browserPaneChrome';
import { rankSites, sitesSnapshot, subscribeSites } from '../../state/browserSiteHistory';
import { displayUrl, prettyUrl, toNavigableUrl } from '../../lib/browserNavUrl';
import { computeMenuPosition } from '../../lib/popoverPosition';
import {
  POPOVER_SURFACE, POPOVER_MARGIN, Z_POPOVER, POPOVER_ITEM, POPOVER_ITEM_DANGER,
  POPOVER_DIVIDER,
} from '../../lib/popoverStyles';
import { copyText } from '../../lib/clipboard';
import { useT } from '../../hooks/useT';
import { shortcut } from '../../lib/shortcutLabel';
import type { DeviceMode } from './browserDevTypes';

/** Past this an address stops being read and starts being scanned; under it a
 *  pinned tab's sheet would be too narrow to hold one. */
const MAX_WIDTH = 460;
const MIN_WIDTH = 300;

/** How many rows each suggestion list contributes. Two short lists beat one
 *  long one: they answer different questions ("where was I in this tab" and
 *  "which sites are mine") and a merged list answers neither. */
const SUGGESTIONS = 5;

const DEVICE_GLYPH: Record<DeviceMode, typeof Monitor> = {
  desktop: Monitor, mobile: Smartphone, tablet: Tablet, auto: Maximize, custom: Maximize,
};

/** One icon in a command row: a label that lives in the tooltip, not on screen. */
function RowButton({
  icon, label, onClick, disabled, testId,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      title={label}
      aria-label={label}
      data-testid={testId}
      className="w-7 h-7 flex items-center justify-center rounded-md text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
    >
      {icon}
    </button>
  );
}

/** A section heading. Quiet: the sheet is read top to bottom, and a loud
 *  heading every four rows turns a panel into a form. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-1.5 pb-0.5 text-micro font-medium uppercase tracking-wide text-app-text-faint select-none">
      {children}
    </div>
  );
}

/** One suggestion: an address you can go back to in one click. */
function Suggestion({
  icon, primary, secondary, title, onClick,
}: {
  icon: React.ReactNode;
  primary: string;
  secondary?: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={POPOVER_ITEM} onClick={onClick} title={title}>
      <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 text-app-text-tertiary">{icon}</span>
      <span className="flex-1 min-w-0 truncate text-left">{primary}</span>
      {secondary && <span className="shrink-0 max-w-[40%] truncate text-app-text-faint text-mini">{secondary}</span>}
    </button>
  );
}

export function BrowserTabSheet({ paneId, label }: { paneId: string; label: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const t = useT();
  const request = chrome?.addressEditRequest ?? 0;
  const downloadsRequest = chrome?.downloadsOpenRequest ?? 0;

  // Adjusted DURING the render, the way React wants a state to react to a prop:
  // a request the tab has not acted on yet opens the sheet once.
  //
  // THE DRAFT IS SEEDED WITH THE DOCUMENT, NOT WITH THE TRANSPORT. A local file
  // travels as `…/api/media?path=%2F…`, so seeding the raw url put an address
  // nobody can read, edit or recognise under the caret. `displayUrl` gives back
  // the document, and `toNavigableUrl` on submit turns it into the transport
  // again: the same pair, both ways.
  const [seen, setSeen] = useState(request);
  const [draft, setDraft] = useState<string | null>(null);
  // Which door was used, decided at the instant of opening and not derived from
  // comparing the two counters: they grow independently, so "downloads is the
  // bigger one" is false after three ⌘L and one click on the cue.
  const [wantsCaret, setWantsCaret] = useState(true);
  if (request !== seen) {
    setSeen(request);
    if (request > seen) {
      setDraft(displayUrl(chrome?.url ?? ''));
      setWantsCaret(true);
    }
  }

  // THE SECOND DOOR OPENS THE SAME PANEL AND ASKS FOR SOMETHING ELSE: the
  // downloads cue wants its list, not the caret. Opened from there the address
  // field is NOT focused and NOT selected, so looking at a file never leaves a
  // selection to undo on a page you were only reading. `downloadsOpen` is the
  // counter `DownloadsMenu` watches (`requestOpen`), so the section is already
  // down when the panel appears.
  const [seenDl, setSeenDl] = useState(downloadsRequest);
  const [downloadsOpen, setDownloadsOpen] = useState(0);
  if (downloadsRequest !== seenDl) {
    setSeenDl(downloadsRequest);
    if (downloadsRequest > seenDl) {
      setDownloadsOpen((n) => n + 1);
      // The field carries the address either way (it is the top of the panel,
      // and an empty one would read as "no page").
      if (draft === null) setDraft(displayUrl(chrome?.url ?? ''));
      setWantsCaret(false);
    }
  }
  const open = draft !== null;

  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const close = useCallback(() => setDraft(null), []);

  // THE PAGE IS A STILL WHILE THE SHEET COVERS IT, and it says so itself rather
  // than waiting to be measured. `thaw` on close AND on unmount: a pane whose
  // tab is dragged to another group while its sheet is open would otherwise
  // leave the page parked behind a picture with nothing left to bring it back.
  const freeze = chrome?.commands.freeze;
  const thaw = chrome?.commands.thaw;
  useEffect(() => {
    if (!open) return;
    freeze?.();
    return () => { thaw?.(); };
  }, [open, freeze, thaw]);

  // THE SHEET IS MEASURED, NOT GUESSED, and placed by the same function as the
  // tab context menu: it clamps to the viewport and flips above the tab when
  // there is no room below.
  useLayoutEffect(() => {
    if (!open || typeof document === 'undefined') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to a constant on close: converges at once and cannot loop
      setPos(null);
      return;
    }
    // The anchor is the TAB, not the label span inside it: the sheet lines up
    // with the tab's bottom and left edges, the way a browser's own address
    // dropdown does.
    const anchorEl = anchorRef.current?.closest('[data-pane-id]') ?? anchorRef.current;
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const width = Math.min(MAX_WIDTH, Math.max(r.width, MIN_WIDTH));
    const height = panelRef.current?.getBoundingClientRect().height ?? 0;
    const next = computeMenuPosition(
      { top: r.top, right: r.right, bottom: r.bottom, left: r.left },
      { width, height },
      { margin: POPOVER_MARGIN, minHeight: Math.min(height, 220) },
    );
    setPos((prev) =>
      prev && prev.top === next.top && prev.left === next.left
        && prev.width === width && prev.maxHeight === next.maxHeight
        ? prev
        : { top: next.top, left: next.left, width, maxHeight: next.maxHeight },
    );
  }, [open, chrome]);

  useEffect(() => {
    if (!open || !wantsCaret) return;
    // After the paint that mounts the field: focus and select, so a new address
    // is one keystroke away. It is the first thing the requirement asks for -
    // and only of the door that asked for the caret (see `wantsCaret`).
    const timer = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    return () => clearTimeout(timer);
  }, [open, wantsCaret]);

  // A CLICK OUTSIDE CLOSES, AND THE CLICK STILL HAPPENS.
  //
  // Not `useDismissable`: that contract EATS the click that follows an outside
  // pointerdown ("closing is all that click does"), which is right for a menu
  // and wrong here, because a blank pane opens this sheet BY ITSELF - so the
  // very next click anywhere (the X of a tab, a toggle in a drawer) would close
  // the sheet and do nothing else. Measured on CI run 34050396220 (2026-09-06)
  // when the address dropdown had that contract. Listening on `pointerdown`
  // without swallowing keeps both: the sheet goes, the click lands.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      // A popover the sheet itself opened (the console panel, the downloads
      // list) is portalled OUT of it: a click in there is a click inside, and
      // closing the sheet under it would take its own anchor away.
      if (target instanceof Element && target.closest('.glass-surface')) return;
      close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);

  const address = chrome ? prettyUrl(chrome.url) : '';
  const copyAddress = useCallback(() => {
    if (!address) return;
    // `copyText` is the one door that answers with a boolean instead of
    // throwing: outside a secure context (LAN over http, some webviews) nothing
    // is copied, and saying "Copied" there would be a lie.
    void copyText(address).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [address]);

  // The frecency grid of the new-tab page, as a short list. Subscribed, so a
  // visit recorded while the sheet is open reorders it.
  const storedSites = useSyncExternalStore(subscribeSites, sitesSnapshot, sitesSnapshot);
  const sites = useMemo(() => rankSites(storedSites, SUGGESTIONS), [storedSites]);

  const go = useCallback((raw: string) => {
    const typed = raw.trim();
    setDraft(null);
    if (typed) chrome?.commands.navigate?.(toNavigableUrl(typed));
  }, [chrome]);

  const run = useCallback((fn?: () => void) => () => { setDraft(null); fn?.(); }, []);

  const c = chrome?.commands;
  const errors = chrome?.consoleErrors ?? 0;
  const warnings = chrome?.consoleWarnings ?? 0;
  const consoleEntries = chrome?.consoleEntries;
  const downloadsMenu = chrome?.downloadsMenu;
  const deviceMode = chrome?.deviceMode ?? 'desktop';
  const DeviceGlyph = DEVICE_GLYPH[deviceMode] ?? Monitor;

  // The responsive box. `sizing` is the WISH (you pressed the custom segment),
  // separate from `deviceMode === 'custom'` which is the FACT: the row has to be
  // there before the numbers exist, otherwise there is nowhere to type them.
  const [sizing, setSizing] = useState(false);
  const [cw, setCw] = useState('414');
  const [ch, setCh] = useState('896');
  const setDevice = c?.setDevice;
  const applySize = useCallback(() => {
    const w = parseInt(cw, 10);
    const h = parseInt(ch, 10);
    if (w > 0 && h > 0) setDevice?.('custom', { width: w, height: h });
  }, [cw, ch, setDevice]);
  // The pane's OWN address list, minus the page it is on: a suggestion that
  // takes you where you already are is a row of noise.
  const paneHistory = useMemo(
    () => (chrome?.history ?? []).filter((u) => u !== chrome?.url).slice(0, SUGGESTIONS),
    [chrome],
  );
  const hasTools = !!(consoleEntries || downloadsMenu || c?.toggleDevTools);

  return (
    <>
      <span ref={anchorRef}>{label}</span>
      {open && chrome && (
        <div
          ref={panelRef}
          data-testid="browser-tab-sheet"
          role="dialog"
          aria-label={t('browser.tab.sheet.title')}
          className={`fixed ${POPOVER_SURFACE} overflow-y-auto overscroll-contain`}
          style={{
            // Until the measure lands the sheet is off-screen and invisible:
            // rendered (it has to be, to be measured) but never shown at the
            // wrong place, so it does not jump from one corner to another.
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            width: pos?.width,
            minWidth: MIN_WIDTH,
            maxWidth: MAX_WIDTH,
            maxHeight: pos?.maxHeight,
            visibility: pos ? 'visible' : 'hidden',
            zIndex: Z_POPOVER,
          }}
          // The tab bar drags and selects on these: the sheet keeps them.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 1. WHERE YOU ARE, ready to be rewritten. */}
          <div className="px-2 pt-1 pb-1.5 flex items-center gap-2">
            <BrowserFavicon url={chrome.url} faviconUrl={chrome.faviconUrl} size={14} className="shrink-0 ml-1" />
            <input
              ref={inputRef}
              data-testid="browser-tab-address-input"
              value={draft ?? ''}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') go(draft ?? '');
                else if (e.key === 'Escape') { e.preventDefault(); close(); }
              }}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('browser.url.placeholder')}
              aria-label={t('browser.tab.sheet.address')}
              className="flex-1 min-w-0 bg-transparent outline-none text-app-text text-compact py-1 p-0 m-0 border-0 placeholder-app-text-faint"
            />
          </div>

          {/* 2. HOW TO MOVE. Icons in a row and not five menu lines: they are
              the frequent ones, and five lines of text for five arrows is how
              a panel becomes a wall. */}
          <div className="px-2 pb-1.5 flex items-center gap-1">
            <RowButton
              icon={<ArrowLeft size={14} />}
              label={t('browser.tab.back')}
              onClick={c?.back && chrome.canGoBack ? run(c.back) : undefined}
              disabled={!chrome.canGoBack}
              testId="browser-tab-back"
            />
            <RowButton
              icon={<ArrowRight size={14} />}
              label={t('browser.tab.forward')}
              onClick={c?.forward && chrome.canGoForward ? run(c.forward) : undefined}
              disabled={!chrome.canGoForward}
              testId="browser-tab-forward"
            />
            <RowButton
              icon={<RotateCw size={14} className={chrome.loading ? 'animate-spin' : ''} />}
              label={t('browser.tab.reload')}
              onClick={run(c?.reload)}
            />
            <div className="flex-1" />
            <RowButton
              icon={copied ? <Check size={14} className="text-green-600 dark:text-green-400" /> : <Copy size={14} />}
              label={copied ? t('browser.tab.copied') : t('browser.tab.copyAddress')}
              onClick={chrome.url ? copyAddress : undefined}
              testId="browser-tab-copy-url"
            />
            <RowButton
              icon={<ExternalLink size={14} />}
              label={t('browser.openSystem')}
              onClick={c?.openExternal ? run(c.openExternal) : undefined}
            />
          </div>

          {/* 3. WHERE YOU HAVE BEEN: this tab's own list, then your sites. */}
          {paneHistory.length > 0 && (
            <>
              <div className={POPOVER_DIVIDER} />
              <SectionLabel>{t('browser.tab.sheet.recent')}</SectionLabel>
              {paneHistory.map((entry) => (
                <Suggestion
                  key={entry}
                  icon={<Clock size={13} />}
                  primary={prettyUrl(entry)}
                  title={displayUrl(entry)}
                  // Shown short, navigated RAW: the history keeps the transport
                  // url because that is what reopens the page.
                  onClick={() => { setDraft(null); c?.navigate?.(entry); }}
                />
              ))}
            </>
          )}

          {sites.length > 0 && (
            <>
              <div className={POPOVER_DIVIDER} />
              <SectionLabel>{t('browser.newTab.topSites')}</SectionLabel>
              {sites.map((site) => (
                <Suggestion
                  key={site.host}
                  icon={site.favicon
                    ? <BrowserFavicon url={site.url} faviconUrl={site.favicon} size={13} />
                    : <Compass size={13} />}
                  primary={site.host}
                  secondary={site.title || undefined}
                  title={displayUrl(site.url)}
                  onClick={() => { setDraft(null); c?.navigate?.(site.url); }}
                />
              ))}
            </>
          )}

          {c?.backToSpawner && (
            <>
              <div className={POPOVER_DIVIDER} />
              <button type="button" className={POPOVER_ITEM} onClick={run(c.backToSpawner)} data-testid="browser-tab-spawner">
                <CornerUpLeft size={13} className="shrink-0 text-app-text-tertiary" />
                <span className="flex-1 text-left">{t('browser.spawner.title')}</span>
              </button>
            </>
          )}

          {/* 4. TOOLS. The console panel and the downloads list anchor to THEIR
              OWN buttons, which are here: that is what "anchored to the sheet"
              means, and it is why the row above the page had to exist before. */}
          {hasTools && (
            <>
              <div className={POPOVER_DIVIDER} />
              <SectionLabel>{t('browser.tab.sheet.tools')}</SectionLabel>
              {consoleEntries && c?.clearConsole && (
                <ConsoleBadge
                  entries={consoleEntries}
                  summary={{ errors, warnings }}
                  onClear={c.clearConsole}
                  label={t('browser.tab.console')}
                  testId="browser-tab-console"
                />
              )}
              {downloadsMenu && (
                <DownloadsMenu
                  {...downloadsMenu}
                  // Opened from the tab's cue, the list is already down: the
                  // click that got here WAS the request to see it. Opened by
                  // ⌘L it must NOT be, and `DownloadsMenu` compares against
                  // zero (a request can predate its own mount), so the counter
                  // is only handed over on the door that asked for it.
                  requestOpen={wantsCaret ? 0 : downloadsOpen}
                  label={t('browser.tab.downloads')}
                  testId="browser-tab-downloads"
                />
              )}
              {c?.toggleDevTools && (
                <button type="button" className={POPOVER_ITEM} onClick={run(c.toggleDevTools)} data-testid="browser-tab-devtools">
                  <Code2 size={13} className="shrink-0 text-app-text-tertiary" />
                  <span className="flex-1 text-left">DevTools</span>
                  <span className="text-app-text-faint tabular-nums">{shortcut('I', { alt: true })}</span>
                </button>
              )}
            </>
          )}

          {/* 5. ZOOM stays a ROW, not three lines: it is the one control here
              you use twice in a row, and a panel that closed between the two
              presses would make you reopen it to finish the thought. */}
          {c?.setZoom && (
            <>
              <div className={POPOVER_DIVIDER} />
              <div className="px-3 py-1 flex items-center gap-2" data-testid="browser-tab-zoom">
                <span className="flex-1 text-compact text-app-text">{t('browser.tab.zoom')}</span>
                <div className="flex items-center rounded-md border border-app-border-input overflow-hidden">
                  <button type="button" onClick={() => c.setZoom?.(-1)} title={t('browser.dev.zoomOut')}
                    className="w-6 h-6 flex items-center justify-center hover:bg-app-hover text-app-text-secondary">
                    <Minus size={12} />
                  </button>
                  <button type="button" onClick={() => c.setZoom?.('reset')} title={t('browser.dev.zoomReset')}
                    className={`px-1.5 h-6 text-mini tabular-nums hover:bg-app-hover ${Math.round(chrome.zoom) !== 100 ? 'text-primary font-medium' : 'text-app-text-tertiary'}`}>
                    {Math.round(chrome.zoom)}%
                  </button>
                  <button type="button" onClick={() => c.setZoom?.(1)} title={t('browser.dev.zoomIn')}
                    className="w-6 h-6 flex items-center justify-center hover:bg-app-hover text-app-text-secondary">
                    <Plus size={12} />
                  </button>
                </div>
              </div>
            </>
          )}

          {/* 6. DEVICE, segmented for the same reason as zoom: five presets are
              five taps of comparison, not five decisions.

              AND `custom` IS ONE OF THE FIVE, not a menu behind them. It used to
              live in `DeviceSwitcher`, a dropdown in the toolbar, and it is the
              only mode that needs two numbers: picking it opens the W×H row
              right underneath, in this same panel. A second menu here is exactly
              what `TOPIC-BROWSER-02` forbids, and dropping the mode instead
              would have quietly taken the responsive box away with the row. */}
          {c?.setDevice && (
            <>
              <div className="px-3 py-1 flex items-center gap-2" data-testid="browser-tab-device">
                <span className="flex-1 text-compact text-app-text flex items-center gap-1.5">
                  <DeviceGlyph size={13} className="text-app-text-tertiary" />
                  {t('browser.tab.device')}
                </span>
                <div className="flex items-center rounded-md border border-app-border-input overflow-hidden">
                  {(['desktop', 'mobile', 'tablet', 'auto', 'custom'] as DeviceMode[]).map((m) => {
                    const G = DEVICE_GLYPH[m];
                    const on = deviceMode === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        // `custom` without a box yet keeps the current page size
                        // and just opens the row: the numbers are the gesture.
                        onClick={() => { if (m === 'custom') setSizing(true); else { setSizing(false); c.setDevice?.(m); } }}
                        title={t('browser.dev.device', { name: m })}
                        aria-pressed={on}
                        data-testid={`browser-tab-device-${m}`}
                        className={`w-6 h-6 flex items-center justify-center hover:bg-app-hover ${on ? 'text-primary bg-app-hover' : 'text-app-text-secondary'}`}
                      >
                        <G size={12} />
                      </button>
                    );
                  })}
                </div>
              </div>
              {(sizing || deviceMode === 'custom') && (
                <div className="px-3 pb-1 flex items-center gap-1 justify-end" data-testid="browser-tab-device-size">
                  <input
                    value={cw} onChange={(e) => setCw(e.target.value)} placeholder="W" inputMode="numeric"
                    aria-label={t('browser.dev.width')}
                    className="w-14 px-1 py-0.5 text-mini bg-surface border border-app-border-input rounded text-app-text-heading"
                  />
                  <span className="text-app-text-faint text-mini">×</span>
                  <input
                    value={ch} onChange={(e) => setCh(e.target.value)} placeholder="H" inputMode="numeric"
                    aria-label={t('browser.dev.height')}
                    className="w-14 px-1 py-0.5 text-mini bg-surface border border-app-border-input rounded text-app-text-heading"
                  />
                  <button
                    type="button"
                    onClick={applySize}
                    data-testid="browser-tab-device-size-apply"
                    className="ml-1 px-1.5 py-0.5 text-mini rounded bg-primary text-white hover:bg-primary/90"
                  >
                    OK
                  </button>
                </div>
              )}
            </>
          )}

          {/* 7. SESSION: this device's, not "sharing with other people". */}
          {c?.toggleShare && (
            <>
              <div className={POPOVER_DIVIDER} />
              <SectionLabel>{t('browser.tab.sheet.session')}</SectionLabel>
              <button
                type="button"
                className={POPOVER_ITEM}
                onClick={() => c.toggleShare?.()}
                data-testid="browser-tab-share"
                data-share-mode={chrome.shareMode ?? (chrome.shared ? 'shared' : 'native')}
                aria-pressed={chrome.shared}
                title={t('browser.tab.session.hint')}
              >
                <MonitorSmartphone size={13} className={`shrink-0 ${chrome.shared ? 'text-green-600 dark:text-green-400' : 'text-app-text-tertiary'}`} />
                <span className="flex-1 text-left">
                  {chrome.shareMode === 'auto'
                    ? t('browser.tab.session.auto')
                    : chrome.shared ? t('browser.tab.session.shared') : t('browser.tab.session.native')}
                </span>
              </button>
            </>
          )}

          {/* 8. The only entry here that destroys something, and it is last and
              apart. The ellipsis is a promise: the click opens the list of what
              goes away, it does not delete. */}
          {c?.forgetSite && (
            <>
              <div className={POPOVER_DIVIDER} />
              <button type="button" className={POPOVER_ITEM_DANGER} onClick={run(c.forgetSite)} data-testid="browser-tab-forget-site">
                <Trash2 size={13} className="shrink-0" />
                {t('browser.forget.label')}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
