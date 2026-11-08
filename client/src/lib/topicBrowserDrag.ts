export interface TopicBrowserPosition {
  right: number;
  bottom: number;
}

export interface TopicBrowserDragPositionInput {
  areaWidth: number;
  areaHeight: number;
  windowWidth: number;
  windowHeight: number;
  startLeft: number;
  startTop: number;
  deltaX: number;
  deltaY: number;
  minimumBottom: number;
}

export function resolveTopicBrowserDragPosition(input: TopicBrowserDragPositionInput): TopicBrowserPosition {
  const right = input.areaWidth - input.startLeft - input.windowWidth - input.deltaX;
  const bottom = input.areaHeight - input.startTop - input.windowHeight - input.deltaY;
  return {
    right: Math.max(0, Math.min(input.areaWidth - input.windowWidth, right)),
    bottom: Math.max(input.minimumBottom, Math.min(input.areaHeight - input.windowHeight, bottom)),
  };
}

/** Which edges a resize handle drags. A corner drags two. */
export interface TopicBrowserResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

export interface TopicBrowserResizeInput {
  areaWidth: number;
  areaHeight: number;
  /** The window when the gesture started, in area-local px. */
  start: { left: number; top: number; width: number; height: number };
  edges: TopicBrowserResizeEdges;
  deltaX: number;
  deltaY: number;
  minWidth: number;
  minHeight: number;
  /** Lowest `bottom` the window may reach (the composer's band). */
  minimumBottom: number;
}

/**
 * The floating window after dragging some of its edges, as the bottom-right
 * anchor the store keeps plus a size.
 *
 * Each dragged edge follows the pointer and the opposite edge stays put. An edge
 * stops at the area's border and at the window's minimum size, so a pointer
 * that overshoots does not drag the opposite edge along with it.
 */
export function resolveTopicBrowserResize(input: TopicBrowserResizeInput): {
  position: TopicBrowserPosition;
  size: { width: number; height: number };
} {
  const { start, edges } = input;
  let left = start.left;
  let right = start.left + start.width;
  let top = start.top;
  let bottom = start.top + start.height;
  const floor = Math.max(0, input.areaHeight - input.minimumBottom);
  if (edges.left) left = Math.max(0, Math.min(right - input.minWidth, left + input.deltaX));
  if (edges.right) right = Math.min(input.areaWidth, Math.max(left + input.minWidth, right + input.deltaX));
  if (edges.top) top = Math.max(0, Math.min(bottom - input.minHeight, top + input.deltaY));
  if (edges.bottom) bottom = Math.min(Math.max(floor, start.top + start.height), Math.max(top + input.minHeight, bottom + input.deltaY));
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return {
    position: {
      right: Math.max(0, Math.round(input.areaWidth - right)),
      bottom: Math.max(0, Math.round(input.areaHeight - bottom)),
    },
    size: { width: Math.round(width), height: Math.round(height) },
  };
}

export interface AnimationFrameScheduler {
  request(callback: () => void): number;
  cancel(frameId: number): void;
}

export interface AnimationFrameCoalescer<T> {
  schedule(value: T): void;
  flush(): void;
  cancel(): void;
}

export function createAnimationFrameCoalescer<T>(
  scheduler: AnimationFrameScheduler,
  apply: (value: T) => void,
): AnimationFrameCoalescer<T> {
  let frameId: number | null = null;
  let hasValue = false;
  let latestValue: T;

  const run = (): void => {
    frameId = null;
    if (!hasValue) return;
    hasValue = false;
    apply(latestValue);
  };

  return {
    schedule(value) {
      latestValue = value;
      hasValue = true;
      if (frameId !== null) return;
      frameId = scheduler.request(run);
    },
    flush() {
      if (frameId !== null) scheduler.cancel(frameId);
      frameId = null;
      if (!hasValue) return;
      hasValue = false;
      apply(latestValue);
    },
    cancel() {
      if (frameId !== null) scheduler.cancel(frameId);
      frameId = null;
      hasValue = false;
    },
  };
}
