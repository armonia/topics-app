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
