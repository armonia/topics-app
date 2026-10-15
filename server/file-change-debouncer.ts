export const FILE_CHANGE_SETTLE_MS = 50;
export const FILE_CHANGE_DEBOUNCE_MS = 300;

type TimerHandle = unknown;

interface TimerApi {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const systemTimers: TimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Schedules one early refresh and, when a burst continues past it, one final refresh.
 * Cache invalidation runs on every event so each refresh can carry the newest generation.
 * The final refresh needs an event AFTER the early one: an atomic save (a write and
 * a rename a few ms apart) lands inside the settle window and costs one refresh.
 */
export function fileChangeDebouncer(
  refresh: (generation: number) => void,
  invalidate: () => number,
  settleMs = FILE_CHANGE_SETTLE_MS,
  debounceMs = FILE_CHANGE_DEBOUNCE_MS,
  timers: TimerApi = systemTimers,
): { onChange: () => void; cancel: () => void } {
  let generation = 0;
  let changedSinceRefresh = false;
  let active = false;
  let settleTimer: TimerHandle | null = null;
  let quietTimer: TimerHandle | null = null;

  return {
    onChange() {
      generation = invalidate();
      changedSinceRefresh = true;

      if (!active) {
        active = true;
        settleTimer = timers.setTimeout(() => {
          settleTimer = null;
          changedSinceRefresh = false;
          refresh(generation);
        }, settleMs);
      }

      if (quietTimer !== null) timers.clearTimeout(quietTimer);
      quietTimer = timers.setTimeout(() => {
        quietTimer = null;
        active = false;
        if (!changedSinceRefresh) return;
        changedSinceRefresh = false;
        refresh(generation);
      }, debounceMs);
    },
    cancel() {
      if (settleTimer !== null) timers.clearTimeout(settleTimer);
      if (quietTimer !== null) timers.clearTimeout(quietTimer);
      settleTimer = null;
      quietTimer = null;
      active = false;
      changedSinceRefresh = false;
    },
  };
}
