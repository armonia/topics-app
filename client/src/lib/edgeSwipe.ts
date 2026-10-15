export type EdgeSwipeDirection = 'back' | 'forward';

export interface EdgeSwipeArrow {
  direction: EdgeSwipeDirection;
  x: number;
  y: number;
  progress: number;
  ready: boolean;
}

export interface EdgeSwipeState {
  navigation: EdgeSwipeDirection | null;
  arrow: EdgeSwipeArrow | null;
}

const EDGE_PX = 20;
const GESTURE_SLOP_PX = 8;

/** Resolve a horizontal browser-history swipe, in viewer-local CSS pixels. */
export function resolveEdgeSwipe(
  startX: number,
  startY: number,
  width: number,
  dx: number,
  dy: number,
): EdgeSwipeState {
  if (!(width > 0) || Math.abs(dx) <= GESTURE_SLOP_PX || Math.abs(dx) < Math.abs(dy) * 2) {
    return { navigation: null, arrow: null };
  }

  const direction: EdgeSwipeDirection | null = startX <= EDGE_PX && dx > 0
    ? 'back'
    : width - startX <= EDGE_PX && dx < 0
      ? 'forward'
      : null;
  if (!direction) return { navigation: null, arrow: null };

  const threshold = Math.min(width * 0.3, 120);
  const distance = Math.abs(dx);
  const ready = distance >= threshold;
  return {
    navigation: ready ? direction : null,
    arrow: {
      direction,
      x: startX + dx,
      y: startY + dy,
      progress: Math.min(1, distance / threshold),
      ready,
    },
  };
}

/** The strip at the screen's edges that the drawer gesture owns on a phone
 *  (`useSidebarSwipe`, same 28 px): a viewer edge flush with it gives way. */
const SCREEN_EDGE_PX = 28;

export function startsOnScreenEdge(clientX: number, screenWidth: number): boolean {
  return clientX <= SCREEN_EDGE_PX || clientX >= screenWidth - SCREEN_EDGE_PX;
}
