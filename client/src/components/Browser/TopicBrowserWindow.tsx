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
 *    That is the ruling of Tornata 0, written in design.md, §Trascinare: the
 *    IPC floor measured by `wkzprobe drag` is inside a frame at the median but
 *    its tail is one to two frames out, and the live-follow that the sidebar
 *    tried made the pane edge stutter.
 *
 * Promotion is the layout's own door, not a private one: "open as tab" fires
 * the same `browser:open-tab` event a clicked link fires, with the SAME
 * contextId, so the page, its history and the agent driving it survive. The
 * return trip dispatches CLOSE_PANE directly, WITHOUT the tombstone and the
 * server DELETE that a real close carries: the context has to stay alive, and
 * the native view survives the gap because a remount inside the close grace
 * cancels the teardown (`useTauriBrowser`, BROWSER_CLOSE_GRACE_MS).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, Maximize2, Minimize2, ExternalLink } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { RemoteBrowserPanel } from './RemoteBrowserPanel';
import {
  EMPTY_TOPIC_BROWSER_WINDOW,
  MIN_WINDOW_SIZE,
  EXPANDED_WIDTH_BOUNDS,
  getTopicWindow,
  resolveMinRect,
  subscribeTopicWindows,
  topicBrowserWindow,
  type TopicBrowserWindowState,
} from '../../state/topicBrowserWindow';
import { usePaneStore } from '../../state/pane/store';
import { findPaneLocation } from '../../state/pane/store';
import {
  createPaneId,
  getBrowserContextFromPaneId,
  isBrowserPaneId,
  newBrowserContextId,
} from '../../state/pane/adapters/paneConfig';
import { OPEN_TAB_EVENT, type OpenTabDetail } from '../../lib/openLink';
import { DEFAULT_EXPANDED_WIDTH } from './topicBrowserWindowLazy';
/** A promotion younger than this is not yet expected to have a pane on screen,
 *  so the reconciler must not read its absence as "the tab was closed". */
const PROMOTION_GRACE_MS = 5000;

export interface TopicBrowserWindowProps {
  topicId: string;
  /** The topic area: the window floats inside it and docks to its right edge. */
  areaRef: RefObject<HTMLElement | null>;
  /** Where a promoted tab belongs, so the right layout claims the open. */
  projectPath?: string;
}

interface Rect { left: number; top: number; width: number; height: number }

/** The topic area in viewport coordinates, kept fresh across resizes, scrolls
 *  and layout changes of the cell itself. */
function useAreaRect(areaRef: RefObject<HTMLElement | null>): Rect | null {
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

/** Tell the native views to re-measure: a window that MOVED without changing
 *  size fires no ResizeObserver, so nothing else would. */
function requestReflow(): void {
  window.dispatchEvent(new CustomEvent('browser:reflow-request'));
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
  const [addOpen, setAddOpen] = useState(false);
  // Geometry while a gesture is in flight: the store only hears the result, so
  // a drag is one write instead of one per frame.
  const [dragPos, setDragPos] = useState<{ right: number; bottom: number } | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const panes = usePaneStore((s) => s.panes);
  const promotedAt = useRef(new Map<string, number>());

  // A promoted contextId whose pane the layout no longer holds is released, so
  // that page can come back into the window. See `reconcilePromoted`.
  useEffect(() => {
    if (!topicId || !state.promoted.length) return;
    const now = Date.now();
    topicBrowserWindow.reconcilePromoted(topicId, (contextId) => {
      const since = promotedAt.current.get(contextId);
      if (since !== undefined && now - since < PROMOTION_GRACE_MS) return true;
      return !!panes[createPaneId('browser', contextId)];
    });
  }, [topicId, state.promoted, panes]);

  const active = state.tabs.find((t) => t.contextId === state.activeContextId) ?? state.tabs[0] ?? null;

  const expandedWidth = dragWidth ?? state.expandedWidth ?? DEFAULT_EXPANDED_WIDTH;

  const rect = useMemo<Rect | null>(() => {
    if (!area) return null;
    if (state.mode === 'exp') {
      const width = Math.min(expandedWidth, area.width);
      return { left: area.left + area.width - width, top: area.top, width, height: area.height };
    }
    const local = resolveMinRect(
      dragPos ? { ...state, minPos: dragPos } : state,
      { width: area.width, height: area.height },
      MIN_WINDOW_SIZE,
    );
    return { left: area.left + local.left, top: area.top + local.top, width: local.width, height: local.height };
  }, [area, state, expandedWidth, dragPos]);

  // Every geometry change is a reflow request: the page inside is composited by
  // the OS at a rectangle it was told once.
  useEffect(() => { requestReflow(); }, [rect?.left, rect?.top, rect?.width, rect?.height, state.activeContextId]);

  const startMove = useCallback((e: React.PointerEvent) => {
    if (state.mode !== 'min' || !area) return;
    const start = resolveMinRect(state, { width: area.width, height: area.height }, MIN_WINDOW_SIZE);
    const originX = e.clientX;
    const originY = e.clientY;
    const release = freezeNativeViews();
    let latest = { right: area.width - start.left - start.width, bottom: area.height - start.top - start.height };
    const onMove = (ev: PointerEvent): void => {
      latest = {
        right: Math.max(0, Math.min(area.width - start.width, area.width - start.left - start.width - (ev.clientX - originX))),
        bottom: Math.max(0, Math.min(area.height - start.height, area.height - start.top - start.height - (ev.clientY - originY))),
      };
      setDragPos(latest);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragPos(null);
      topicBrowserWindow.move(topicId, latest);
      release();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [state, area, topicId]);

  const startResize = useCallback((e: React.PointerEvent) => {
    if (state.mode !== 'exp' || !area) return;
    const originX = e.clientX;
    const startWidth = expandedWidth;
    const release = freezeNativeViews();
    let latest = startWidth;
    const onMove = (ev: PointerEvent): void => {
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
      release();
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
    const paneId = createPaneId('browser', contextId);
    const store = usePaneStore.getState();
    const loc = findPaneLocation(store, paneId);
    if (loc) store.dispatch({ type: 'CLOSE_PANE', payload: { id: paneId, groupId: loc.groupId, groupIndex: loc.groupIndex } });
    promotedAt.current.delete(contextId);
    if (getTopicWindow(topicId).promoted.includes(contextId)) {
      topicBrowserWindow.returnFromTab(topicId, { contextId, url, title });
    } else {
      topicBrowserWindow.open(topicId, { contextId, url, title });
    }
  }, [topicId]);

  /** The project's browser panes, offered by the «+»: they are in the layout,
   *  so they are listed to be BROUGHT IN, never duplicated. */
  const layoutBrowsers = useMemo(
    () => Object.values(panes)
      .filter((p) => isBrowserPaneId(p.id))
      .map((p) => ({ contextId: getBrowserContextFromPaneId(p.id) ?? '', url: p.url ?? '', title: p.title ?? '' }))
      .filter((p) => !!p.contextId && !state.tabs.some((t) => t.contextId === p.contextId)),
    [panes, state.tabs],
  );

  if (!topicId || state.mode === 'hidden' || !rect || !state.tabs.length) return null;

  const expanded = state.mode === 'exp';

  return createPortal(
    <div
      data-testid="topic-browser-window"
      data-mode={state.mode}
      // The window is not an overlay for the native views it contains, and it
      // declares the corner radius the shell rounds its page to.
      data-native-browser-slot=""
      data-native-radius={expanded ? 0 : 10}
      className="fixed z-30 flex flex-col overflow-hidden bg-surface border border-app-border shadow-xl"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        borderRadius: expanded ? 0 : 10,
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
        onPointerDown={(e) => { if (e.target === e.currentTarget) startMove(e); }}
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
          <div className="relative">
            <button
              data-testid="topic-browser-add"
              aria-label={tr('topicBrowser.add')}
              title={tr('topicBrowser.add')}
              onClick={() => setAddOpen((v) => !v)}
              className="w-6 h-6 flex items-center justify-center rounded text-app-text-tertiary hover:bg-app-hover"
            >
              <Plus size={13} />
            </button>
            {addOpen && (
              <div data-testid="topic-browser-add-menu" className="absolute top-7 left-0 z-20 min-w-[220px] py-1 rounded-md border border-app-border bg-surface shadow-lg">
                <button
                  data-testid="topic-browser-add-new"
                  onClick={() => { setAddOpen(false); topicBrowserWindow.open(topicId, { contextId: newBrowserContextId() }); }}
                  className="w-full text-left px-3 py-1.5 text-compact hover:bg-app-hover"
                >
                  {tr('topicBrowser.newSheet')}
                </button>
                {layoutBrowsers.map((p) => (
                  <button
                    key={p.contextId}
                    data-testid="topic-browser-add-existing"
                    onClick={() => { setAddOpen(false); takeFromLayout(p.contextId, p.url, p.title); }}
                    className="w-full text-left px-3 py-1.5 text-compact truncate hover:bg-app-hover"
                  >
                    {p.title || p.url}
                  </button>
                ))}
              </div>
            )}
          </div>
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
        <button
          data-testid={expanded ? 'topic-browser-minimize' : 'topic-browser-expand'}
          aria-label={expanded ? tr('topicBrowser.minimize') : tr('topicBrowser.expand')}
          title={expanded ? tr('topicBrowser.minimize') : tr('topicBrowser.expand')}
          onClick={() => topicBrowserWindow.setMode(topicId, expanded ? 'min' : 'exp')}
          className="w-6 h-6 flex items-center justify-center rounded text-app-text-tertiary hover:bg-app-hover"
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
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
              isVisible={t.contextId === active?.contextId}
              onUrlChange={(url) => topicBrowserWindow.updateSheet(topicId, t.contextId, { url })}
              onTitleChange={(title) => topicBrowserWindow.updateSheet(topicId, t.contextId, { title })}
            />
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
