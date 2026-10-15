import { useCallback, useRef, useState, type TouchEvent } from 'react';
import { resolveEdgeSwipe, startsOnScreenEdge, type EdgeSwipeArrow } from '../lib/edgeSwipe';
import { useLayoutMobile } from './useMobile';
import { flingVelocity } from '../lib/mirrorScroll';

interface Point { x: number; y: number }

interface Options {
  getRoot: () => HTMLDivElement | null;
  getOverlay: () => HTMLDivElement | null;
  isSelecting: () => boolean;
  isAgentActive: () => boolean;
  focusKbdAt: (x: number, y: number, requireField: boolean) => void;
  prepareTouch: () => void;
  getScale: () => number;
  getDims: () => { w: number; h: number };
  toSource: (x: number, y: number) => Point | null;
  scrollMirrorBy: (dx: number, dy: number, x: number, y: number) => boolean;
  queueScrollRelay: (dx: number, dy: number, x: number, y: number) => void;
  startFling: (vx: number, vy: number, x: number, y: number) => void;
  relayTap: (x: number, y: number) => void;
  goBack: () => void;
  goForward: () => void;
}

interface TouchState {
  x: number;
  y: number;
  startX: number;
  startY: number;
  rootX: number;
  rootY: number;
  width: number;
  travel: number;
  edgeAxis: 'pending' | 'scroll' | 'navigate' | 'plain';
  pendingMoves: { t: number; x: number; y: number }[];
  moves: { t: number; dx: number; dy: number }[];
}

/** Own the touch path so edge navigation does not push the mirror over its size gate. */
export function useDomCoBrowseTouch(options: Options) {
  const touchRef = useRef<TouchState | null>(null);
  const [arrow, setArrow] = useState<EdgeSwipeArrow | null>(null);
  // The same predicate that turns the drawer gesture on (useSidebarAndLayout).
  const drawerLayout = useLayoutMobile();

  const onTouchStart = useCallback((event: TouchEvent) => {
    if (options.isSelecting() || options.isAgentActive()) return;
    const touch = event.touches[0];
    const root = options.getRoot();
    if (!touch || !root) return;
    const bounds = root.getBoundingClientRect();
    const overlay = options.getOverlay();
    const inOverlay = !!overlay?.contains(event.target as Node);
    const rootX = touch.clientX - bounds.left;
    const rootY = touch.clientY - bounds.top;
    // On a phone the screen's edges open and hold the drawer: there the viewer
    // does not start a history swipe, or both would run on the same finger.
    const drawerEdge = drawerLayout && startsOnScreenEdge(touch.clientX, window.innerWidth);
    const edgeOrigin = !drawerEdge && (rootX <= 20 || bounds.width - rootX <= 20);
    if (!inOverlay && !edgeOrigin) return;

    options.prepareTouch();
    if (inOverlay) {
      options.focusKbdAt(touch.clientX, touch.clientY, true);
      root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
    touchRef.current = {
      x: touch.clientX, y: touch.clientY, startX: touch.clientX, startY: touch.clientY,
      rootX, rootY, width: bounds.width, travel: 0,
      edgeAxis: edgeOrigin ? 'pending' : 'plain', pendingMoves: [], moves: [],
    };
    setArrow(null);
  }, [options, drawerLayout]);

  const onTouchMove = useCallback((event: TouchEvent) => {
    if (options.isSelecting()) return;
    const previous = touchRef.current;
    const touch = event.touches[0];
    if (!previous || !touch) return;
    const root = options.getRoot();
    if (!root) return;
    const bounds = root.getBoundingClientRect();
    const dxTotal = touch.clientX - previous.startX;
    const dyTotal = touch.clientY - previous.startY;
    const edge = resolveEdgeSwipe(previous.rootX, previous.rootY, previous.width, dxTotal, dyTotal);
    if (previous.edgeAxis === 'pending') {
      previous.pendingMoves.push({ t: event.timeStamp, x: touch.clientX, y: touch.clientY });
      previous.travel += Math.abs(previous.x - touch.clientX) + Math.abs(previous.y - touch.clientY);
      previous.x = touch.clientX;
      previous.y = touch.clientY;
      if (edge.arrow) {
        previous.edgeAxis = 'navigate';
        setArrow(edge.arrow);
        if (event.cancelable) event.preventDefault();
        return;
      }
      const verticalScroll = Math.abs(dyTotal) > 8 && Math.abs(dyTotal) >= Math.abs(dxTotal) * 2;
      const horizontalScroll = Math.abs(dxTotal) > 8 && Math.abs(dxTotal) >= Math.abs(dyTotal) * 2;
      if (!verticalScroll && !horizontalScroll) return;
      previous.edgeAxis = 'scroll';
      flushPendingScroll(previous, options);
      return;
    }
    if (previous.edgeAxis === 'navigate') {
      setArrow(edge.arrow ?? (arrow && { ...arrow, x: touch.clientX - bounds.left, y: touch.clientY - bounds.top }));
      if (event.cancelable) event.preventDefault();
      previous.travel += Math.abs(previous.x - touch.clientX) + Math.abs(previous.y - touch.clientY);
      previous.x = touch.clientX;
      previous.y = touch.clientY;
      return;
    }

    const scale = options.getScale() || 1;
    const dx = (previous.x - touch.clientX) / scale;
    const dy = (previous.y - touch.clientY) / scale;
    previous.travel += Math.abs(previous.x - touch.clientX) + Math.abs(previous.y - touch.clientY);
    previous.x = touch.clientX;
    previous.y = touch.clientY;
    previous.moves.push({ t: event.timeStamp, dx, dy });
    if (previous.moves.length > 16) previous.moves.shift();
    const point = options.toSource(touch.clientX, touch.clientY) ?? {
      x: options.getDims().w / 2,
      y: options.getDims().h / 2,
    };
    if (!options.isAgentActive()) options.scrollMirrorBy(dx, dy, point.x, point.y);
    options.queueScrollRelay(dx, dy, point.x, point.y);
  }, [arrow, options]);

  const onTouchEnd = useCallback((event: TouchEvent) => {
    if (options.isSelecting() || options.isAgentActive()) {
      touchRef.current = null;
      setArrow(null);
      return;
    }
    const previous = touchRef.current;
    touchRef.current = null;
    if (!previous) { setArrow(null); return; }
    const touch = event.changedTouches[0];
    if (previous.edgeAxis === 'pending' && touch) {
      const edge = resolveEdgeSwipe(previous.rootX, previous.rootY, previous.width,
        touch.clientX - previous.startX, touch.clientY - previous.startY);
      if (edge.arrow) {
        previous.edgeAxis = 'navigate';
        setArrow(edge.arrow);
      } else {
        previous.edgeAxis = 'scroll';
        flushPendingScroll(previous, options);
      }
    }
    if (previous.edgeAxis === 'navigate') {
      const navigation = touch && resolveEdgeSwipe(previous.rootX, previous.rootY, previous.width,
        touch.clientX - previous.startX, touch.clientY - previous.startY).navigation;
      setArrow(null);
      if (navigation === 'back') options.goBack();
      else if (navigation === 'forward') options.goForward();
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (previous.travel > 8) {
      const { vx, vy } = flingVelocity(previous.moves, event.timeStamp);
      const point = options.toSource(previous.x, previous.y) ?? {
        x: options.getDims().w / 2,
        y: options.getDims().h / 2,
      };
      if (Math.hypot(vx, vy) > 0.02) options.startFling(vx, vy, point.x, point.y);
      return;
    }
    if (!touch) return;
    options.relayTap(touch.clientX, touch.clientY);
    if (event.cancelable) event.preventDefault();
  }, [options]);

  const onTouchCancel = useCallback(() => {
    touchRef.current = null;
    setArrow(null);
  }, []);

  return { arrow, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };
}

function flushPendingScroll(previous: TouchState, options: Options): void {
  const scale = options.getScale() || 1;
  let lastX = previous.startX;
  let lastY = previous.startY;
  for (const move of previous.pendingMoves) {
    const dx = (lastX - move.x) / scale;
    const dy = (lastY - move.y) / scale;
    const point = options.toSource(move.x, move.y) ?? {
      x: options.getDims().w / 2,
      y: options.getDims().h / 2,
    };
    if (!options.isAgentActive()) options.scrollMirrorBy(dx, dy, point.x, point.y);
    options.queueScrollRelay(dx, dy, point.x, point.y);
    previous.moves.push({ t: move.t, dx, dy });
    lastX = move.x;
    lastY = move.y;
  }
  if (previous.moves.length > 16) previous.moves.splice(0, previous.moves.length - 16);
  previous.pendingMoves.length = 0;
}
