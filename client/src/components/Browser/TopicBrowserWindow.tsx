/**
 * THE BROWSER WINDOW A TOPIC OWNS.
 *
 * One window per topic, in one of three modes, drawn over (minimized) or beside
 * (expanded) the topic area. The state is `state/topicBrowserWindow.ts`, pure
 * and persisted per topic; this file is the surface, and it is deliberately the
 * ONLY place that turns those reducer ops into layout side effects.
 *
 * THREE THINGS THAT ARE NOT OBVIOUS, and each of them was paid for once:
 *
 * 1. The window is PORTALED to the body and positioned `fixed` from a measured
 *    rectangle, instead of being absolutely placed inside the chat cell. A
 *    transformed ancestor becomes the containing block of every `fixed`
 *    descendant, and the tab strip above the chat has one: the same trap that
 *    put the tab sheet at y = -3 (see `BrowserTabSheet`). Measuring the topic
 *    area and drawing on the body is what gives the window the viewport back.
 *
 * 2. Moving a window does NOT move the native page inside it. The WKWebView is
 *    composited by the OS at a rectangle it was told once; the placeholder only
 *    re-measures on a resize, a mutation or its slow poll. So every geometry
 *    change ends with `browser:reflow-request`, which the placeholder listens
 *    for already.
 *
 * 3. A drag runs with the page FROZEN (`freeze()`/`thaw()` on the drag gate,
 *    through the `topics:pane-resize-*` events the gate already understands).
 *    That is the ruling written in design.md, in the dragging section: the
 *    IPC floor measured by `wkzprobe drag` is inside a frame at the median but
 *    its tail is one to two frames out, and the live-follow that the sidebar
 *    tried made the pane edge stutter.
 *
 * Promotion is the layout's own door, not a private one: "open as tab" fires
 * the same `browser:open-tab` event a clicked link fires, with the SAME
 * contextId, so the page, its history and the agent driving it survive. The
 * return trip goes through RECLAIM_PANE, which DOES write the tombstone but
 * carries neither an undo entry nor the server DELETE a real close carries:
 * the context has to stay alive, and the native view survives the gap
 * because a remount inside the close grace cancels the teardown
 * (`useTauriBrowser`, BROWSER_CLOSE_GRACE_MS).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Z_CONTEXT_MENU, Z_POPOVER_SCRIM } from '@/lib/popoverStyles';
import { Plus, X, Maximize2, Minimize2, ExternalLink } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { RemoteBrowserPanel } from './RemoteBrowserPanel';
import { useSurfaceFocus } from './useSurfaceFocus';
import {
  EMPTY_TOPIC_BROWSER_WINDOW,
  MIN_WINDOW_SIZE,
  type ComposerBand,
  EXPANDED_WIDTH_BOUNDS,
  getTopicWindow,
  resolveMinRect,
  resolveComposerAvoidance,
  subscribeTopicWindows,
  topicBrowserWindow,
  type TopicBrowserWindowState,
} from '../../state/topicBrowserWindow';
import { usePaneStore } from '../../state/pane/store';
import {
  listProjectBrowserPanes,
  subscribeProjectBrowserPanes,
  isProjectBrowserPaneOpen,
} from '../../state/pane/adapters/projectBrowserPanes';
import { returnSheetToWindow } from './returnToTopicWindow';
import {
  createPaneId,
  getBrowserContextFromPaneId,
  isBrowserPaneId,
  newBrowserContextId,
} from '../../state/pane/adapters/paneConfig';
import { OPEN_TAB_EVENT, type OpenTabDetail } from '../../lib/openLink';
import { registerTopicWindowDoor } from '../../lib/topicWindowDoor';
import { tauriInvoke } from '../../lib/shell/tauri';
import { DEFAULT_EXPANDED_WIDTH, expandedInsetFor, canExpandInArea } from './topicBrowserWindowLazy';
/** A promotion younger than this is not yet expected to have a pane on screen,
 *  so the reconciler must not read its absence as "the tab was closed". */
const PROMOTION_GRACE_MS = 5000;
/** Height of the window when every page of the topic is out on loan: the bar
 *  alone, which is the only thing that can bring one back. */
const BAR_ONLY_HEIGHT = 36;
/** A pointer that travelled less than this was a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

export interface TopicBrowserWindowProps {
  topicId: string;
  /** The topic area: the window floats inside it and docks to its right edge. */
  areaRef: AreaRef;
  /** Where a promoted tab belongs, so the right layout claims the open. */
  projectPath?: string;
}

interface Rect { left: number; top: number; width: number; height: number }

/** The topic area in viewport coordinates, kept fresh across resizes, scrolls
 *  and layout changes of the cell itself. */
type AreaRef = RefObject<HTMLElement | null>;

function useAreaRect(areaRef: AreaRef): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const read = (): void => {
      const r = el.getBoundingClientRect();
      setRect((prev) => (prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height
        ? prev
        : { left: r.left, top: r.top, width: r.width, height: r.height }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    window.addEventListener('resize', read);
    window.addEventListener('scroll', read, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', read); window.removeEventListener('scroll', read, true); };
  }, [areaRef]);
  return rect;
}

/** Where the composer lies inside the area, in px from the area's top.
 *
 *  Measured, never assumed: the composer grows with the text, carries the
 *  queue box and the strips above it, slides on a transform when the
 *  transcript pushes it, and sits in the MIDDLE while the topic is empty.
 *  The floating window keeps off that band, so the send button stays
 *  clickable. Null while there is nothing to measure. */
function useComposerBand(areaRef: AreaRef): ComposerBand | null {
  const [band, setBand] = useState<ComposerBand | null>(null);
  useEffect(() => {
    const root = areaRef.current;
    if (!root) return;
    let composer: Element | null = null;
    const sizes = new ResizeObserver(() => read());
    // The composer slides with an INLINE transform and changes class when it
    // docks: neither is a resize, and both move its top edge.
    const styles = new MutationObserver(() => read());
    // The composer is a direct child of the pane root: watching the root's own
    // child list catches it appearing, without walking the transcript.
    const mounts = new MutationObserver(() => read());
    const areaSize = new ResizeObserver(() => read());

    function read(): void {
      // Re-read the ref: an observer can fire in the same frame the pane
      // unmounts, and then there is no area left to measure against.
      const host = areaRef.current;
      if (!host) return;
      const next = host.querySelector('[data-testid="chat-input-area"]');
      if (next !== composer) {
        sizes.disconnect();
        styles.disconnect();
        composer = next;
        if (composer) {
          sizes.observe(composer);
          styles.observe(composer, { attributes: true, attributeFilter: ['style', 'class'] });
        }
      }
      const box = (composer?.querySelector('form') ?? composer)?.getBoundingClientRect();
      const bounds = host.getBoundingClientRect();
      setBand(
        box && box.height > 0
          ? {
              top: Math.max(0, Math.round(box.top - bounds.top)),
              bottom: Math.max(0, Math.round(box.bottom - bounds.top)),
              centered: composer?.getAttribute('data-composer-centered') === 'true',
            }
          : null,
      );
    }

    read();
    mounts.observe(root, { childList: true });
    areaSize.observe(root);
    window.addEventListener('resize', read);
    return () => {
      sizes.disconnect();
      styles.disconnect();
      mounts.disconnect();
      areaSize.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [areaRef]);
  return band;
}

/** The window state of ONE topic, re-read on every change of the store. */
function useTopicWindowState(topicId: string): TopicBrowserWindowState {
  const [state, setState] = useState<TopicBrowserWindowState>(() => getTopicWindow(topicId));
  useEffect(() => {
    const read = (): void => { setState(getTopicWindow(topicId)); };
    read();
    return subscribeTopicWindows(read);
  }, [topicId]);
  return topicId ? state : EMPTY_TOPIC_BROWSER_WINDOW;
}

/**
 * Put the window's page above the sibling native views.
 *
 * Z order among native views is CREATION order, and nothing but an explicit
 * reorder changes it (`tools/wkzprobe z`): a window opened before a browser
 * pane would float UNDER that pane, which is the one thing a floating window
 * may not do. The raise is a no-op outside the desktop shell, and a declared
 * gap on WebView2 and WebKitGTK (see `browser-platform-parity`).
 */
function raiseNativeView(contextId: string): void {
  if (!contextId) return;
  void tauriInvoke('browser_raise', { id: contextId }).catch(() => {});
}

/** Tell the native views to re-measure: a window that MOVED without changing
 *  size fires no ResizeObserver, so nothing else would. */
function requestReflow(contextId?: string): void {
  // Targeted when we know whose page moved: an untargeted request makes every
  // native view in the app re-send its bounds, and here only one moved.
  window.dispatchEvent(new CustomEvent('browser:reflow-request', { detail: contextId ? { contextId } : undefined }));
}

/** Freeze every native view for the length of a gesture, through the events the
 *  drag gate already listens to. Returns the release. */
function freezeNativeViews(): () => void {
  window.dispatchEvent(new CustomEvent('topics:pane-resize-start'));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    window.dispatchEvent(new CustomEvent('topics:pane-resize-end'));
    requestReflow();
  };
}

export function TopicBrowserWindow({ topicId, areaRef, projectPath }: TopicBrowserWindowProps): React.ReactElement | null {
  const tr = useT();
  const state = useTopicWindowState(topicId);
  const area = useAreaRect(areaRef);
  const band = useComposerBand(areaRef);
  // The chat beside it and this window take turns: a heavy page pauses while
  // the person types in the chat.
  const focus = useSurfaceFocus();
  const [addOpen, setAddOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  // Where the "+" menu is drawn, in viewport coordinates: it is a portal on the
  // body, because a window shrunk to its bar would clip it away otherwise, and
  // that menu is the ONLY way back for a page lent to the layout.
  const [menuAnchor, setMenuAnchor] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  // Geometry while a gesture is in flight: the store only hears the result, so
  // a drag is one write instead of one per frame.
  const [dragPos, setDragPos] = useState<{ right: number; bottom: number } | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const panes = usePaneStore((s) => s.panes);
  // A project window keeps its panes outside the pane store: it publishes them.
  const projectBrowsers = useSyncExternalStore(
    subscribeProjectBrowserPanes,
    () => listProjectBrowserPanes(projectPath ?? ''),
  );
  const promotedAt = useRef(new Map<string, number>());

  // A promoted contextId whose pane the layout no longer holds is released, so
  // that page can come back into the window. See `reconcilePromoted`.
  useEffect(() => {
    if (!topicId || !state.promoted.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sweep = (): void => {
      const now = Date.now();
      let nextSweepIn = Infinity;
      topicBrowserWindow.reconcilePromoted(topicId, (contextId) => {
        const since = promotedAt.current.get(contextId);
        if (since !== undefined && now - since < PROMOTION_GRACE_MS) {
          nextSweepIn = Math.min(nextSweepIn, since + PROMOTION_GRACE_MS - now);
          return true;
        }
                // A project window holds its panes outside the pane store: a page
        // open there is still LENT, not gone.
        return !!panes[createPaneId('browser', contextId)] || isProjectBrowserPaneOpen(contextId);
      });
      // A tab closed WHILE its promotion was still under grace produces no
      // further store change: without this re-run the id would stay held for
      // good, and `open` would silently refuse that page for ever.
      if (nextSweepIn !== Infinity) timer = setTimeout(sweep, nextSweepIn + 50);
    };
    sweep();
    return () => { if (timer) clearTimeout(timer); };
  }, [topicId, state.promoted, panes, projectBrowsers]);


  // The links of THIS conversation land in THIS window: a page read in the chat
  // belongs beside the chat. Registered rather than listened for, because the
  // claim has to be answered before the layout hooks see the event at all (see
  // `topicWindowDoor`). A sheet already promoted keeps its tab: `open` refuses a
  // promoted contextId, and a fresh contextId per click is never one.
  useEffect(() => registerTopicWindowDoor(topicId, (detail) => {
    topicBrowserWindow.open(topicId, {
      contextId: detail.contextId,
      url: detail.url,
      openedBy: 'link',
    });
    return true;
  }), [topicId]);

  const active = state.tabs.find((t) => t.contextId === state.activeContextId) ?? state.tabs[0] ?? null;

  const expandedWidth = dragWidth ?? state.expandedWidth ?? DEFAULT_EXPANDED_WIDTH;

  // Every page of this topic is a tab of the layout right now: the window keeps
  // the bar, and nothing else. Without it the «+» that takes them back would be
  // unreachable, and a tab closed out there would never release its id.
  const barOnly = !state.tabs.length && state.promoted.length > 0;

  // A chat pane that is not the visible tab keeps its DOM, hidden: its box
  // collapses to zero. The window is a PORTAL, so nothing would hide it with
  // the pane, and topic A's browser would float over topic B.
  const rect = useMemo<Rect | null>(() => {
    if (!area || area.width < 1 || area.height < 1) return null;
    if (barOnly) {
      const local = resolveMinRect(state, { width: area.width, height: area.height, composer: band ?? undefined }, { width: MIN_WINDOW_SIZE.width, height: BAR_ONLY_HEIGHT });
      return { left: area.left + local.left, top: area.top + local.top, width: local.width, height: local.height };
    }
    // Docking needs room for BOTH the window and the chat. In a split
    // project at 1024 the area is about 322px: docked, the window came out
    // 2px wide, its own controls could not be hit, and the persisted `exp`
    // had no way out. Below that floor we stay floating: the bar is always
    // reachable.
    if (state.mode === 'exp' && canExpandInArea(area.width)) {
      // The same number the chat cedes, from the same function: the
      // left edge of the window and the padding of the chat are one
      // edge, not two formulas.
      const width = expandedInsetFor(area.width, expandedWidth);
      return { left: area.left + area.width - width, top: area.top, width, height: area.height };
    }
    const local = resolveMinRect(
      dragPos ? { ...state, minPos: dragPos } : state,
      { width: area.width, height: area.height, composer: band ?? undefined },
      MIN_WINDOW_SIZE,
    );
    return { left: area.left + local.left, top: area.top + local.top, width: local.width, height: local.height };
  }, [area, state, expandedWidth, dragPos, barOnly, band]);

  // The last geometry the window really had, so a parked window can come back
  // where it was instead of jumping to a corner for one frame.
  const lastRect = useRef<Rect | null>(null);
  if (rect) lastRect.current = rect;

  // Every geometry change is a reflow request: the page inside is composited by
  // the OS at a rectangle it was told once.
  useEffect(() => {
    // Parked: there is no geometry to announce, and raising a view that is off
    // screen would put it over the topic the person is actually looking at.
    if (!rect) return;
    requestReflow(state.activeContextId ?? undefined);
    if (state.activeContextId) raiseNativeView(state.activeContextId);
  }, [rect?.left, rect?.top, rect?.width, rect?.height, state.activeContextId, rect]);

  const startMove = useCallback((e: React.PointerEvent) => {
    if (state.mode === 'exp' || !area) return;
    // Anything the bar holds that answers a click of its own keeps its click:
    // the drag is what is left of the bar, which is most of it.
    if ((e.target as HTMLElement | null)?.closest('button, a, input, [role="menu"]')) return;
    const start = resolveMinRect(state, { width: area.width, height: area.height, composer: band ?? undefined }, MIN_WINDOW_SIZE);
    const originX = e.clientX;
    const originY = e.clientY;
    // Freezing paints a still image over every native view: a bar that is only
    // being clicked must not pay for it, so it is armed at the first real move.
    let release: (() => void) | null = null;
    const guard = resolveComposerAvoidance(
      { height: area.height, composer: band ?? undefined },
      start.height,
    );
    let latest = { right: area.width - start.left - start.width, bottom: area.height - start.top - start.height };
    const onMove = (ev: PointerEvent): void => {
      if (!release && Math.abs(ev.clientX - originX) + Math.abs(ev.clientY - originY) < DRAG_THRESHOLD_PX) return;
      release ??= freezeNativeViews();
      latest = {
        right: Math.max(0, Math.min(area.width - start.width, area.width - start.left - start.width - (ev.clientX - originX))),
        // Clamped at the source too, not only on the way out: what gets
        // persisted is a position the window can actually hold.
        bottom: Math.max(guard.floor, Math.min(area.height - start.height, area.height - start.top - start.height - (ev.clientY - originY))),
      };
      setDragPos(latest);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragPos(null);
      topicBrowserWindow.move(topicId, latest);
      release?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [state, area, topicId, band]);

  const startResize = useCallback((e: React.PointerEvent) => {
    if (state.mode !== 'exp' || !area) return;
    const originX = e.clientX;
    const startWidth = expandedWidth;
    let release: (() => void) | null = null;
    let latest = startWidth;
    const onMove = (ev: PointerEvent): void => {
      if (!release && Math.abs(ev.clientX - originX) < DRAG_THRESHOLD_PX) return;
      release ??= freezeNativeViews();
      latest = Math.max(
        EXPANDED_WIDTH_BOUNDS.min,
        Math.min(EXPANDED_WIDTH_BOUNDS.max, Math.min(area.width, startWidth - (ev.clientX - originX))),
      );
      setDragWidth(latest);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragWidth(null);
      topicBrowserWindow.setWidth(topicId, latest);
      release?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [state.mode, area, expandedWidth, topicId]);

  /** Hand the active sheet to the layout, with the same contextId. */
  const openAsTab = useCallback((contextId: string, url: string) => {
    const detail: OpenTabDetail = { url: url || 'about:blank', contextId, topicId, projectPath };
    const claimed = !window.dispatchEvent(new CustomEvent<OpenTabDetail>(OPEN_TAB_EVENT, { detail, cancelable: true }));
    // Nobody can host a tab here (a detached window with no grid): the sheet
    // stays where it is rather than vanishing into a layout that refused it.
    if (!claimed) return;
    promotedAt.current.set(contextId, Date.now());
    topicBrowserWindow.promoteToTab(topicId, contextId);
  }, [topicId, projectPath]);

  /** Take a pane out of the layout WITHOUT destroying its context. */
  const takeFromLayout = useCallback((contextId: string, url: string, title: string) => {
    promotedAt.current.delete(contextId);
    returnSheetToWindow({ contextId, url, title }, topicId);
  }, [topicId]);

  const layoutBrowsers = useMemo(
    () => [
      ...Object.values(panes)
        .filter((p) => isBrowserPaneId(p.id))
        .map((p) => ({ contextId: getBrowserContextFromPaneId(p.id) ?? '', url: p.url ?? '', title: p.title ?? '' })),
      ...projectBrowsers,
    ].filter((p, i, all) =>
      !!p.contextId
      && !state.tabs.some((t) => t.contextId === p.contextId)
      && all.findIndex((o) => o.contextId === p.contextId) === i),
    [panes, projectBrowsers, state.tabs],
  );

  useEffect(() => {
    if (!addOpen) { setMenuAnchor(null); return; }
    const anchor = addButtonRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = 240;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left));
    // A window parked at the bottom of the screen has no room BELOW its bar:
    // the menu then hangs upwards, which is the only place it fits.
    const room = window.innerHeight - anchor.bottom - 12;
    const height = Math.min(window.innerHeight * 0.5, 44 * (layoutBrowsers.length + 1) + 8);
    const top = room >= height ? anchor.bottom + 4 : Math.max(8, anchor.top - 4 - height);
    setMenuAnchor({ left, top, maxHeight: Math.min(height, window.innerHeight - 16) });
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') setAddOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [addOpen, layoutBrowsers.length]);
  if (!topicId) return null;
  if (!barOnly && !state.tabs.length) return null;


  // The topic is not the one on screen (its chat pane is collapsed to zero, or
  // it was never measured): the window is PARKED, not unmounted. Unmounting it
  // would take RemoteBrowserPanel down with it and destroy the page, so coming
  // back to the topic would reload it and lose the history. Parked means: kept
  // in the DOM, hidden, and every sheet told it is not visible, which is what
  // makes the shell take its native views off screen.
  //
  // The X parks too. It used to return early here and unmount the panels,
  // which closed the pages: history, forms and the agent own view, exactly
  // what the topic switch is careful to keep.
  const hidden = !barOnly && state.mode === 'hidden';
  const parked = !rect || hidden;
  const box = rect ?? lastRect.current;
  // One answer for the whole render: if the area cannot host a docked window,
  // `exp` is not what this window IS, whatever the persisted state says. The
  // rect above already falls back to floating, so the flag must agree or
  // the chrome would dress a docked window around a floating box.
  const canExpand = !!area && canExpandInArea(area.width);
  const expanded = state.mode === 'exp' && canExpand && !barOnly;

  return createPortal(
    <div
      data-testid="topic-browser-window"
      {...focus.captureProps}
      data-mode={barOnly ? 'loaned' : (expanded ? 'exp' : 'min')}
      // The window is not an overlay for the native views it contains, and it
      // declares the corner radius the shell rounds its page to.
      data-native-browser-slot=""
      data-native-radius={expanded ? 0 : 10}
      data-parked={parked ? '' : undefined}
      className="fixed z-30 flex flex-col overflow-hidden bg-surface border border-app-border shadow-xl"
      style={{
        left: box?.left ?? 0,
        top: box?.top ?? 0,
        width: box?.width ?? MIN_WINDOW_SIZE.width,
        height: box?.height ?? MIN_WINDOW_SIZE.height,
        borderRadius: expanded ? 0 : 10,
        display: parked ? 'none' : undefined,
      }}
    >
      {expanded && (
        <div
          data-testid="topic-browser-resize-handle"
          onPointerDown={startResize}
          className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize z-10 hover:bg-primary/30"
        />
      )}
      <div
        data-testid="topic-browser-bar"
        onPointerDown={startMove}
        className={`flex items-center gap-1 px-1.5 h-9 flex-shrink-0 border-b border-app-border bg-surface ${expanded ? '' : 'cursor-grab active:cursor-grabbing'}`}
      >
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden">
          {state.tabs.map((t) => (
            <button
              key={t.contextId}
              data-testid="topic-browser-tab"
              data-context-id={t.contextId}
              data-active={t.contextId === active?.contextId}
              onClick={() => topicBrowserWindow.activate(topicId, t.contextId)}
              className={`flex items-center gap-1 px-2 h-7 rounded text-mini truncate max-w-[160px] ${t.contextId === active?.contextId ? 'bg-app-hover text-app-text' : 'text-app-text-tertiary hover:bg-app-hover'}`}
            >
              <span className="truncate">{t.title || t.url || tr('browser.url.placeholder')}</span>
              <X
                size={11}
                data-testid="topic-browser-tab-close"
                onClick={(e) => { e.stopPropagation(); topicBrowserWindow.close(topicId, t.contextId); }}
              />
            </button>
          ))}
          <button
            ref={addButtonRef}
            data-testid="topic-browser-add"
            aria-label={tr('topicBrowser.add')}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            title={tr('topicBrowser.add')}
            onClick={() => setAddOpen((v) => !v)}
            className="w-6 h-6 flex items-center justify-center rounded text-app-text-tertiary hover:bg-app-hover"
          >
            <Plus size={13} />
          </button>
        </div>
        <button
          data-testid="topic-browser-open-as-tab"
          aria-label={tr('topicBrowser.openAsTab')}
          title={tr('topicBrowser.openAsTab')}
          disabled={!active}
          onClick={() => { if (active) openAsTab(active.contextId, active.url); }}
          className="w-6 h-6 flex items-center justify-center rounded text-app-text-tertiary hover:bg-app-hover disabled:opacity-40"
        >
          <ExternalLink size={13} />
        </button>
        {canExpand && (
        <button
          data-testid={expanded ? 'topic-browser-minimize' : 'topic-browser-expand'}
          aria-label={expanded ? tr('topicBrowser.minimize') : tr('topicBrowser.expand')}
          title={expanded ? tr('topicBrowser.minimize') : tr('topicBrowser.expand')}
          onClick={() => topicBrowserWindow.setMode(topicId, expanded ? 'min' : 'exp')}
          className="w-6 h-6 flex items-center justify-center rounded text-app-text-tertiary hover:bg-app-hover"
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        )}
        <button
          data-testid="topic-browser-close"
          aria-label={tr('topicBrowser.close')}
          title={tr('topicBrowser.close')}
          onClick={() => topicBrowserWindow.setMode(topicId, 'hidden')}
          className="w-6 h-6 flex items-center justify-center rounded text-app-text-tertiary hover:bg-app-hover"
        >
          <X size={13} />
        </button>
      </div>
      {addOpen && menuAnchor && createPortal(
        <>
          <div
            data-testid="topic-browser-add-backdrop"
            className="fixed inset-0"
            style={{ zIndex: Z_POPOVER_SCRIM }}
            onPointerDown={() => setAddOpen(false)}
          />
          <div
            data-testid="topic-browser-add-menu"
            role="menu"
            className="fixed min-w-[220px] overflow-auto py-1 rounded-md border border-app-border bg-surface shadow-lg"
            style={{
              left: menuAnchor.left,
              top: menuAnchor.top,
              maxHeight: menuAnchor.maxHeight,
              zIndex: Z_CONTEXT_MENU,
            }}
          >
            <button
              data-testid="topic-browser-add-new"
              role="menuitem"
              onClick={() => { setAddOpen(false); topicBrowserWindow.open(topicId, { contextId: newBrowserContextId() }); }}
              className="w-full text-left px-3 py-1.5 text-compact hover:bg-app-hover"
            >
              {tr('topicBrowser.newSheet')}
            </button>
            {layoutBrowsers.map((p) => (
              <button
                key={p.contextId}
                data-testid="topic-browser-add-existing"
                data-context-id={p.contextId}
                role="menuitem"
                onClick={() => { setAddOpen(false); takeFromLayout(p.contextId, p.url, p.title); }}
                className="w-full text-left px-3 py-1.5 text-compact truncate hover:bg-app-hover"
              >
                {p.title || p.url}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
      {/* Every sheet stays mounted, only the active one is visible: switching
          sheet must not reload a page, exactly like the tab ladder of a group. */}
      <div className="flex-1 min-h-0 relative">
        {state.tabs.map((t) => (
          <div
            key={t.contextId}
            data-testid="topic-browser-sheet"
            data-context-id={t.contextId}
            className="absolute inset-0 flex flex-col"
            style={{ display: t.contextId === active?.contextId ? 'flex' : 'none' }}
          >
            <RemoteBrowserPanel
              contextId={t.contextId}
              initialUrl={t.url || undefined}
              isVisible={!parked && t.contextId === active?.contextId}
              onUrlChange={(url) => topicBrowserWindow.updateSheet(topicId, t.contextId, { url })}
              onTitleChange={(title) => topicBrowserWindow.updateSheet(topicId, t.contextId, { title })}
              hasFocus={focus.focused}
              onSelfFocus={focus.claim}
            />
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
