/**
 * WHAT THE TAB SHEET DRAWS. When it opens, and why it is one surface, is in
 * `TabSheet`; this module is loaded lazily behind it (`tabSheetLazy.ts`).
 *
 * Top to bottom, the order a person reaches for things in:
 *   1. the header: for a browser tab the address and the navigation row (its
 *      copy icon is the ONE command that copies the page address), for any
 *      other tab its name;
 *   2. the suggestions, only from the address doors (TABSHEET-01);
 *   3. the first level, built by `buildTabSheetEntries`, with the levels that
 *      open beside their row (`SubmenuItem`, as in the user menu).
 *
 * The panel is PORTALLED to <body> and placed from the tab's rectangle: it
 * starts on the tab's bottom edge, lined up with its left edge (its right one
 * when the left does not fit), so the tab and the sheet read as one surface
 * (`data-sheet-open` on the tab paints it with the same fill). It re-places
 * itself every frame the tab moves or changes width while it is open.
 *
 * `POPOVER_SURFACE` is not a style choice: `glass-surface` is what the native
 * occlusion watcher (`lib/shell/browserOcclusion`) matches to park a WKWebView
 * under the panel; the levels carry `role="menu"`, which it matches too.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Copy, Check, Clock, Compass } from 'lucide-react';
import { BrowserFavicon } from '../Browser/BrowserFavicon';
import { setFramesInteractive } from '../Browser/hostedIframe';
import type { BrowserPaneChrome } from '../../state/browserPaneChrome';
import { rankSites, sitesSnapshot, subscribeSites } from '../../state/browserSiteHistory';
import { displayUrl, prettyUrl, toNavigableUrl } from '../../lib/browserNavUrl';
import {
  POPOVER_SURFACE, POPOVER_SHEET, POPOVER_MARGIN, Z_POPOVER, Z_POPOVER_SCRIM, POPOVER_ITEM, POPOVER_DIVIDER,
  DANGER_TEXT,
} from '../../lib/popoverStyles';
import { copyText } from '../../lib/clipboard';
import { useExitGhost } from '../../lib/exitGhost';
import { useT } from '../../hooks/useT';
import { keepSystemMenuOffPanel } from '../../lib/contextMenuOrigin';
import { useMobile } from '../../hooks/useMobile';
import { useMenuKeyboard, firstMenuItem } from '../../hooks/useMenuKeyboard';
import { useSplitLayoutAvailable } from '../../hooks/useSplitLayoutAvailable';
import { useCopyTabLink } from '../../hooks/useCopyTabLink';
import { useToast } from './Toast';
import { shortcut } from '../../lib/shortcutLabel';
import { isDesktop } from '../../lib/shell';
import { useTopics } from '../../contexts/TopicsContext';
import { useTopicLoading } from '../../state/signals';
import { hasFinder, openFind } from '../../state/findRegistry';
import { usePaneStore } from '../../state/pane/store';
import { resolvePaneSpace, liveSpaceCount } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, SPACES_MAX } from '../../state/pane/types';
import {
  getTerminalSessionFromPaneId, isDraftPaneId, isTerminalPaneId, pinKeyForPane, tabTargetForPane,
} from '../../state/pane/adapters';
import { createSpaceId, isDetachedWindow, liveSpacesOrdered, movePaneToSpace, nextSpaceName } from '../Layout/spaceHelpers';
import { getBrowserPaneUrl, isRealUrl } from '../../state/pane/browserPaneUrl';
import { restartTerminalSession } from '../../lib/terminalReload';
import { menuRowClass } from '../Sidebar/menuRow';
import { TopicColorDot } from './TopicColorDot';
import { SubmenuItem, SubmenuOwnerProvider } from './SubmenuItem';
import { buildTabSheetEntries, DEVICE_LABEL_KEY, type SheetEntry, type TabSheetModel } from './tabSheetEntries';
import { ControlRow, type ControlRenderers } from './tabSheetControls';
import type { TabSheetDoor } from '../../state/tabSheet';
import type { TabSheetTarget } from './tabSheetTypes';

/** Past this an address stops being read and starts being scanned. */
const MAX_WIDTH = 460;
const MIN_WIDTH = 288;
/** Each suggestion list contributes at most this many rows. */
const SUGGESTIONS = 5;
/** A level is at least this wide, so its longest row (detach the group into a new window) fits. */
const LEVEL_MIN_WIDTH = 248;

interface TabSheetBodyProps {
  door: TabSheetDoor;
  seq: number;
  /** The element the sheet grows out of: the tab, or the phone title. */
  anchor: () => HTMLElement | null;
  panelRef: React.RefObject<HTMLDivElement | null>;
  /** The mark every level and popover of this sheet carries. */
  owner: string;
  target: TabSheetTarget;
  chrome: BrowserPaneChrome | undefined;
  draft: string;
  onDraftChange: (draft: string) => void;
  onClose: () => void;
}

/** One icon of the navigation row: its label lives in the tooltip. */
function NavButton({ icon, label, onClick, disabled, testId }: {
  icon: React.ReactNode; label: string; onClick?: () => void; disabled?: boolean; testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      title={label}
      aria-label={label}
      data-testid={testId}
      className="w-7 h-7 coarse:w-11 coarse:h-11 flex items-center justify-center rounded-md text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
    >
      {icon}
    </button>
  );
}

/** A quiet heading: the sheet is read top to bottom. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-1.5 pb-0.5 text-mini font-medium uppercase tracking-wide text-app-text-faint select-none">
      {children}
    </div>
  );
}

/** One suggestion: an address you can go back to in one click. */
function Suggestion({ icon, primary, secondary, title, onClick }: {
  icon: React.ReactNode; primary: string; secondary?: string; title: string; onClick: () => void;
}) {
  return (
    <button type="button" className={POPOVER_ITEM} onClick={onClick} title={title}>
      <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 text-app-text-tertiary">{icon}</span>
      <span className="flex-1 min-w-0 truncate text-left">{primary}</span>
      {secondary && <span className="shrink-0 max-w-[40%] truncate text-app-text-faint text-mini">{secondary}</span>}
    </button>
  );
}

export function TabSheetBody({
  door, seq, anchor, panelRef, owner, target, chrome, draft, onDraftChange, onClose,
}: TabSheetBodyProps) {
  const t = useT();
  const toast = useToast();
  const { isMobile } = useMobile();
  const topics = useTopics();
  const splitLayoutAvailable = useSplitLayoutAvailable();
  const { copyTabLink } = useCopyTabLink();
  const spacesRegistry = usePaneStore((s) => s.spaces);
  const { pane, surface } = target;
  const isBrowser = pane.type === 'browser';
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number; tabLeft: number; tabWidth: number; side: 'left' | 'right' } | null>(null);
  const [suggest, setSuggest] = useState(door === 'address');
  const [copied, setCopied] = useState(false);
  useExitGhost(panelRef, true, isMobile ? 'sheet' : 'popover');

  // PLACED ON THE TAB, AND KEPT THERE. Measured every frame while open: the tab
  // can slide (the strip scrolls, a neighbour grows to the active width, a tab
  // to its left closes) without the window resizing, and each of those is a
  // sheet hanging from a tab that is not there any more.
  useLayoutEffect(() => {
    if (isMobile) return;
    let frame = 0;
    const place = () => {
      const tab = anchor();
      if (tab) {
        const r = tab.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const width = Math.min(MAX_WIDTH, Math.max(r.width, MIN_WIDTH), vw - 2 * POPOVER_MARGIN);
        const side: 'left' | 'right' = r.left + width <= vw - POPOVER_MARGIN ? 'left' : 'right';
        const left = side === 'left' ? r.left : Math.max(POPOVER_MARGIN, r.right - width);
        const top = r.bottom;
        const maxHeight = Math.max(160, vh - top - POPOVER_MARGIN);
        setPos((prev) => (prev && prev.top === top && prev.left === left && prev.width === width
          && prev.maxHeight === maxHeight && prev.tabLeft === r.left && prev.tabWidth === r.width
          ? prev
          : { top, left, width, maxHeight, tabLeft: r.left, tabWidth: r.width, side }));
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [anchor, isMobile]);

  // WHERE THE FOCUS LANDS depends on the door (TABSHEET-01): the address
  // doors select the address, the downloads cue leaves the field alone, the
  // commands door (right click, long press, Shift+F10) goes to the first row.
  const placed = pos !== null || isMobile;
  useEffect(() => {
    if (!placed) return;
    const timer = setTimeout(() => {
      if (door === 'address' && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      } else if (door === 'commands' && listRef.current) {
        firstMenuItem(listRef.current)?.focus({ preventScroll: true });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [placed, door, seq]);

  // A HOSTED FRAME DOES NOT TELL THE APP IT WAS CLICKED: while the sheet covers
  // the pane the frames stop taking the pointer, so a click on the page lands
  // on the slot and closes the sheet. Given back on close (this unmount).
  useEffect(() => {
    if (!isBrowser) return;
    setFramesInteractive(false);
    return () => setFramesInteractive(true);
  }, [isBrowser]);

  const run = useCallback((fn?: () => void) => () => { onClose(); fn?.(); }, [onClose]);
  const onKeyDown = useMenuKeyboard({ panelRef: listRef });

  // A BROWSER TAB NEVER BROUGHT TO THE FRONT has no chrome (its pane is not
  // mounted, so it published nothing), and its address is still known: the
  // pane carries it, or the store does. The old tab menu copied it from there,
  // and the sheet must not lose that (TABSHEET-03).
  const storedUrl = isBrowser && !chrome
    ? (isRealUrl(pane.url) ? pane.url : getBrowserPaneUrl(pane.id))
    : undefined;
  const address = prettyUrl(chrome ? chrome.url : (storedUrl ?? ''));
  const copyAddress = useCallback(() => {
    if (!address) return;
    // `copyText` answers with a boolean: outside a secure context nothing is
    // copied, and saying "Copied" there would be a lie.
    void copyText(address).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [address]);

  const storedSites = useSyncExternalStore(subscribeSites, sitesSnapshot, sitesSnapshot);
  const sites = useMemo(() => (isBrowser ? rankSites(storedSites, SUGGESTIONS) : []), [storedSites, isBrowser]);
  const paneHistory = useMemo(
    () => (chrome ? chrome.history.filter((u) => u !== chrome.url).slice(0, SUGGESTIONS) : []),
    [chrome],
  );
  const go = useCallback((raw: string) => {
    const typed = raw.trim();
    onClose();
    if (typed) chrome?.commands.navigate?.(toNavigableUrl(typed));
  }, [chrome, onClose]);

  const working = useTopicLoading(pane.type === 'chat' ? pane.topicId : undefined);
  const model = useTabSheetModel({ target, chrome, working, splitLayoutAvailable, spacesRegistry, copyTabLink, toast, t });
  const entries = useMemo(() => buildTabSheetEntries(model), [model]);

  const c = chrome?.commands;
  const copyButton = (
    <NavButton
      icon={copied ? <Check size={14} className="text-green-600 dark:text-green-400" /> : <Copy size={14} />}
      label={copied ? t('browser.tab.copied') : t('browser.tab.copyAddress')}
      onClick={address ? copyAddress : undefined}
      testId="browser-tab-copy-url"
    />
  );
  const header = isBrowser && chrome && c ? (
    <>
      <div className="px-2 pt-1 pb-1.5 flex items-center gap-2">
        <BrowserFavicon url={chrome.url} faviconUrl={chrome.faviconUrl} size={14} className="shrink-0 ml-1" />
        <input
          ref={inputRef}
          data-testid="browser-tab-address-input"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onFocus={() => setSuggest(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') go(draft);
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('browser.url.placeholder')}
          aria-label={t('browser.tab.sheet.address')}
          className="flex-1 min-w-0 coarse:min-h-11 bg-transparent outline-none text-app-text text-compact coarse:text-body-lg py-1 p-0 m-0 border-0 placeholder-app-text-faint"
        />
      </div>
      {/* HOW TO MOVE: icons in a row, the frequent ones. The copy icon is
          the ONE command that copies the page address: the old tab menu had
          a second row for the same thing under another name. */}
      <div className="px-2 pb-1.5 flex items-center gap-1">
        <NavButton icon={<ArrowLeft size={14} />} label={t('browser.tab.back')} onClick={c.back && chrome.canGoBack ? run(c.back) : undefined} disabled={!chrome.canGoBack} testId="browser-tab-back" />
        <NavButton icon={<ArrowRight size={14} />} label={t('browser.tab.forward')} onClick={c.forward && chrome.canGoForward ? run(c.forward) : undefined} disabled={!chrome.canGoForward} testId="browser-tab-forward" />
        <NavButton icon={<RotateCw size={14} className={chrome.loading ? 'animate-spin' : ''} />} label={t('browser.tab.reload')} onClick={run(c.reload)} testId="tab-sheet-reload" />
        <div className="flex-1" />
        {copyButton}
        <NavButton icon={<ExternalLink size={14} />} label={t('browser.openSystem')} onClick={c.openExternal ? run(c.openExternal) : undefined} testId="tab-sheet-open-external" />
      </div>
    </>
  ) : isBrowser && storedUrl ? (
    // No page to drive yet: the address is read, not edited, and its copy
    // icon is the same one the live header has.
    <div className="px-2 pt-1 pb-1.5 flex items-center gap-2 min-w-0">
      <BrowserFavicon url={storedUrl} size={14} className="shrink-0 ml-1" />
      <span
        data-testid="tab-sheet-address"
        title={displayUrl(storedUrl)}
        className="flex-1 min-w-0 truncate text-compact coarse:text-body-lg text-app-text-secondary select-text"
      >
        {address}
      </span>
      {copyButton}
    </div>
  ) : (
    <div className="px-3 pt-1.5 pb-1.5 flex items-center gap-2 min-w-0" data-testid="tab-sheet-title">
      {pane.type === 'chat' && pane.topicId && <TopicColorDot color={topics[pane.topicId]?.color} />}
      <span className="truncate font-medium text-compact text-app-text">{target.label}</span>
      {working && <span className="shrink-0 text-mini text-app-text-faint">{t('tabSheet.working')}</span>}
    </div>
  );

  const suggestions = isBrowser && chrome && suggest && (paneHistory.length > 0 || sites.length > 0) ? (
    <div data-testid="tab-sheet-suggestions">
      {paneHistory.length > 0 && (
        <>
          <div className={POPOVER_DIVIDER} />
          <SectionLabel>{t('browser.tab.sheet.recent')}</SectionLabel>
          {paneHistory.map((entry) => (
            <Suggestion key={entry} icon={<Clock size={13} />} primary={prettyUrl(entry)} title={displayUrl(entry)}
              onClick={() => { onClose(); c?.navigate?.(entry); }} />
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
              icon={site.favicon ? <BrowserFavicon url={site.url} faviconUrl={site.favicon} size={13} /> : <Compass size={13} />}
              primary={site.host}
              secondary={site.title || undefined}
              title={displayUrl(site.url)}
              onClick={() => { onClose(); c?.navigate?.(site.url); }}
            />
          ))}
        </>
      )}
    </div>
  ) : null;

  const controls: ControlRenderers = {
    target, chrome, owner, door, isMobile, onClose, toast, t,
  };

  if (typeof document === 'undefined') return null;
  const seamWidth = pos ? Math.max(0, Math.min(pos.tabWidth, pos.width) - 2) : 0;
  const seamLeft = pos ? Math.max(1, pos.tabLeft - pos.left + 1) : 0;
  return createPortal(
    <>
      {isMobile && <div className="fixed inset-0 bg-black/40 modal-backdrop-enter" style={{ zIndex: Z_POPOVER_SCRIM }} onClick={onClose} />}
      <div
        ref={panelRef}
        data-testid="tab-sheet"
        data-pane-type={pane.type}
        data-surface={surface}
        data-door={door}
        role="dialog"
        aria-label={t('tabSheet.title', { name: target.label })}
        className={isMobile
          ? `fixed bottom-0 left-0 right-0 flex flex-col ${POPOVER_SHEET}`
          : `fixed flex flex-col ${POPOVER_SURFACE}`}
        style={isMobile
          ? { zIndex: Z_POPOVER, maxHeight: 'calc(100dvh - 3rem)', paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)' }
          : {
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: pos?.width,
              maxHeight: pos?.maxHeight,
              visibility: pos ? 'visible' : 'hidden',
              zIndex: Z_POPOVER,
              // The corner on the tab's side is square: the tab continues into it.
              ...(pos?.side === 'left' ? { borderTopLeftRadius: 0 } : { borderTopRightRadius: 0 }),
            }}
        // No system menu over (or under) ours: see `lib/contextMenuOrigin`.
        onContextMenu={keepSystemMenuOffPanel}
        // The tab strip drags and selects on these, and a click here must not
        // reach the tab's own handlers through the React tree.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* THE SEAM: the panel's top border stops under the tab, which is
            what makes the two one surface instead of a tab and a panel. */}
        {!isMobile && pos && (
          <span
            aria-hidden
            data-testid="tab-sheet-seam"
            className="absolute -top-px h-px pointer-events-none"
            style={{ left: seamLeft - 1, width: seamWidth, background: 'inherit' }}
          />
        )}
        {/* The scroll lives inside, so the seam above is not clipped by it. */}
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {/* The WHOLE panel hosts the levels, not only the list: a press on
              the header (Reload, Copy, the address) with a level open is a
              choice made in the sheet, and must not be eaten by the level. */}
          <SubmenuOwnerProvider owner={owner} panelRef={panelRef}>
            {header}
            {suggestions}
            <div className={POPOVER_DIVIDER} />
            <div ref={listRef} role="menu" aria-label={t('tabSheet.commands')} onKeyDown={onKeyDown} data-testid="tab-sheet-commands">
              <EntryList entries={entries} controls={controls} depth={0} />
            </div>
          </SubmenuOwnerProvider>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** A list of entries: a level of the sheet, or its first one. */
function EntryList({ entries, controls, depth }: { entries: SheetEntry[]; controls: ControlRenderers; depth: number }) {
  const { isMobile } = controls;
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'divider') return <div key={entry.id} className={POPOVER_DIVIDER} role="separator" />;
        if (entry.kind === 'control') return <ControlRow key={entry.id} id={entry.id} controls={controls} />;
        if (entry.kind === 'level') {
          return (
            <SubmenuItem
              key={entry.id}
              label={entry.label}
              icon={entry.icon}
              testId={`tab-sheet-level-${entry.id}`}
              minWidth={LEVEL_MIN_WIDTH}
              // The downloads cue lands on its list: the Tools level is open.
              defaultOpen={entry.id === 'tools' && controls.door === 'downloads'}
              tail={entry.tail ? (
                <span className={`shrink-0 text-mini tabular-nums ${entry.tailDanger ? DANGER_TEXT : 'text-app-text-faint'}`}>{entry.tail}</span>
              ) : undefined}
            >
              <SectionLabel>{entry.label}</SectionLabel>
              <EntryList entries={entry.children} controls={controls} depth={depth + 1} />
            </SubmenuItem>
          );
        }
        const Icon = entry.icon;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            data-testid={entry.testId}
            title={entry.title}
            disabled={entry.current}
            aria-current={entry.current ? 'true' : undefined}
            onClick={() => { controls.onClose(); entry.onSelect(); }}
            className={`${menuRowClass(isMobile)} ${entry.danger ? `${DANGER_TEXT} hover:bg-red-600/10` : ''} ${entry.current ? 'text-app-text-muted cursor-default hover:bg-transparent' : ''}`}
          >
            {Icon ? <Icon size={14} className="flex-shrink-0" /> : <span className="w-3.5 flex-shrink-0" />}
            <span className="flex-1 text-left truncate">{entry.label}</span>
            {entry.hint && <span aria-hidden className="shrink-0 text-mini text-app-text-faint tabular-nums">{entry.hint}</span>}
          </button>
        );
      })}
    </>
  );
}

interface ModelInput {
  target: TabSheetTarget;
  chrome: BrowserPaneChrome | undefined;
  working: boolean;
  splitLayoutAvailable: boolean;
  spacesRegistry: ReturnType<typeof usePaneStore.getState>['spaces'];
  copyTabLink: ReturnType<typeof useCopyTabLink>['copyTabLink'];
  toast: ReturnType<typeof useToast>;
  t: ReturnType<typeof useT>;
}

/**
 * The tab's commands, bound. Everything here comes from the callbacks the
 * surface already had (`TabSheetActions`) and from the browser pane's chrome;
 * the gates are the ones the old tab menu applied, moved here unchanged.
 */
function useTabSheetModel({ target, chrome, working, splitLayoutAvailable, spacesRegistry, copyTabLink, toast, t }: ModelInput): TabSheetModel {
  return useMemo<TabSheetModel>(() => {
    const { pane, actions: a, surface } = target;
    const id = pane.id;
    const isBrowser = pane.type === 'browser';
    const isTerminal = isTerminalPaneId(id);
    const kind: TabSheetModel['kind'] = isBrowser ? 'browser' : pane.type === 'chat' ? 'chat' : isTerminal ? 'terminal' : 'utility';
    const c = chrome?.commands;
    const inBar = surface === 'bar';
    const inWindow = surface === 'window';

    const find = hasFinder(id) ? () => {
      if (id !== a.activePaneId) a.onActivate?.(id);
      requestAnimationFrame(() => { openFind(id); });
    } : undefined;

    // Pins: inside a project the two things you can pin are named apart.
    const pins: NonNullable<TabSheetModel['tab']>['pins'] = [];
    if (a.onToggleFissato && !inWindow) {
      const tabKey = pinKeyForPane(pane);
      if (a.projectPinKey) {
        const key = a.projectPinKey;
        pins.push({ scope: 'project', pinned: a.isFissato?.(key) ?? false, toggle: () => a.onToggleFissato?.(key) });
      }
      if (tabKey && tabKey !== a.projectPinKey) {
        pins.push({ scope: a.projectPinKey ? 'tab' : 'single', pinned: a.isFissato?.(tabKey) ?? false, toggle: () => a.onToggleFissato?.(tabKey) });
      }
    }
    const link = inWindow ? null : tabTargetForPane(pane, a.linkContext);
    const canRename = !inWindow && (isTerminal
      || (pane.type === 'chat' && !!pane.topicId && !!a.onRenameChat)
      || (isBrowser && !!a.onRenameBrowser));

    // Layout: only where it has effect. Not on the phone (no splits are drawn
    // there) and not in the topic window (it has none).
    const withLayout = inBar;
    const zoomAvailable = withLayout && !!a.onToggleZoom && (!!a.isZoomed || !!a.canZoom) && !isDraftPaneId(id);
    const moveToGroup = withLayout && a.canMoveToSpace && !isDetachedWindow() ? (() => {
      // The AUTHORITATIVE store pane: the bar's `panes` are rebuilt from ids
      // and never carry `spaceId`.
      const storePane = usePaneStore.getState().panes[id] ?? pane;
      const currentSpace = resolvePaneSpace(storePane, spacesRegistry);
      const groups = [
        { id: DEFAULT_SPACE_ID, name: t('tab.group.main') },
        ...liveSpacesOrdered(spacesRegistry).map((s) => ({ id: s.id, name: s.name || t('tab.group.fallback') })),
      ].map((g) => ({ ...g, current: g.id === currentSpace }));
      return {
        groups,
        currentName: groups.find((g) => g.current)?.name,
        move: (groupId: string) => movePaneToSpace(id, groupId),
        newGroup: liveSpaceCount(spacesRegistry) < SPACES_MAX ? () => {
          const groupId = createSpaceId();
          usePaneStore.getState().dispatch({ type: 'SPACE_UPSERT', payload: { space: { id: groupId, name: nextSpaceName(spacesRegistry) } } });
          movePaneToSpace(id, groupId);
        } : undefined,
      };
    })() : undefined;

    const closable = inWindow ? !!target.window : !a.nonClosablePaneIds?.has(id);
    const zoomLabel = chrome ? `${Math.round(chrome.zoom)}% · ${t(DEVICE_LABEL_KEY[chrome.deviceMode] ?? 'tabSheet.device.desktop')}` : undefined;
    const shareTail = chrome && c?.toggleShare
      ? (chrome.shareMode === 'auto' ? t('tabSheet.tail.shareAuto') : chrome.shared ? t('tabSheet.tail.shared') : t('tabSheet.tail.native'))
      : undefined;

    return {
      kind,
      focused: target.focused,
      t,
      hints: { find: shortcut('F'), close: isDesktop && inBar ? shortcut('W') : undefined },
      contextual: isBrowser && c ? {
        takeControl: chrome?.agentActive ? c.takeControl : undefined,
        returnToChat: inWindow ? undefined : c.returnToTopicWindow,
        openAsTab: inWindow ? target.window?.openAsTab : undefined,
        openInProject: a.onOpenPaneInProject && !inWindow ? () => a.onOpenPaneInProject?.(id) : undefined,
        backToSpawner: c.backToSpawner,
      } : inWindow && target.window ? { openAsTab: target.window.openAsTab } : undefined,
      stopTurn: pane.type === 'chat' && pane.topicId && working && a.onStopStreaming ? () => a.onStopStreaming?.(id) : undefined,
      find,
      chatSettings: pane.type === 'chat' && a.onSettings ? () => a.onSettings?.(id) : undefined,
      reloadSession: isTerminal ? () => {
        const sid = getTerminalSessionFromPaneId(id);
        if (sid) restartTerminalSession(sid, toast, t);
      } : undefined,
      page: isBrowser && c ? { zoom: !!c.setZoom, device: !!c.setDevice, forgetSite: c.forgetSite, tail: zoomLabel } : undefined,
      tools: isBrowser && chrome && c ? {
        console: !!(chrome.consoleEntries && c.clearConsole),
        // The list draws nothing while it is empty (`DownloadsMenu`): a row
        // the shape counted and nobody sees would keep a level of one alive.
        downloads: (chrome.downloadsMenu?.items.length ?? 0) > 0,
        devTools: c.toggleDevTools,
        devToolsHint: shortcut('I', { alt: true }),
        errors: chrome.consoleErrors,
        downloadCount: chrome.downloads,
      } : undefined,
      session: isBrowser && c ? { share: !!c.toggleShare, engine: !!c.setEngine, render: !!c.setRenderMode, tail: shareTail } : undefined,
      tab: inWindow ? undefined : {
        rename: canRename,
        pins,
        copyLink: link ? () => { void copyTabLink(link); } : undefined,
        copyLinkIsTabOfPage: isBrowser,
      },
      layout: withLayout ? {
        zoom: zoomAvailable ? { zoomed: !!a.isZoomed, toggle: (scope) => a.onToggleZoom?.(id, scope) } : undefined,
        splitRight: splitLayoutAvailable && a.onSplitRight ? () => a.onSplitRight?.(id) : undefined,
        splitDown: splitLayoutAvailable && a.onSplitDown ? () => a.onSplitDown?.(id) : undefined,
        resetLayout: splitLayoutAvailable ? a.onResetLayout : undefined,
        moveToGroup,
        detach: a.onDetach ? () => a.onDetach?.(id) : undefined,
        reattach: a.onReattach ? () => a.onReattach?.(id) : undefined,
        popOut: pane.type === 'chat' && a.onPopOut ? () => a.onPopOut?.(id) : undefined,
        popOutGroup: a.onPopOutGroup && a.panes.length > 1 ? a.onPopOutGroup : undefined,
      } : undefined,
      close: closable ? () => {
        if (inWindow) target.window?.close();
        else (a.onCloseImmediate ?? a.onClose)?.(id);
      } : undefined,
      // On the phone title too: its group can hold more than one tab, and
      // «Close others» is a command of every type (TABSHEET-03, -04).
      closeOthers: !inWindow && a.panes.length > 1 ? () => {
        if (a.onCloseOthers) a.onCloseOthers(id);
        else a.panes.forEach((p) => { if (p.id !== id) a.onClose?.(p.id); });
      } : undefined,
    };
  }, [target, chrome, working, splitLayoutAvailable, spacesRegistry, copyTabLink, toast, t]);
}
