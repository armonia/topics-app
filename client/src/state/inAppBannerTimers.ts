/**
 * ONE CLOCK PER BANNER, and it belongs to the banner, not to the list.
 *
 * The obvious way to expire a list in React is an effect over the whole array:
 * it looks right and it is wrong. `showInAppBanner` builds a NEW array at every
 * signal, so the effect re-runs, its cleanup kills every timer still in flight
 * and starts them again with the full TTL. Three banners at t=0/3/6 then die
 * together at t=14 instead of 8/11/14, and the older one silently gains life
 * every time a new one arrives.
 *
 * So the timers live in a map that SURVIVES the re-render: an existing banner
 * keeps the timer it already has, a new one gets its own, and a banner that has
 * left the list gets its timer cancelled. The key carries `shownAt` because a
 * banner re-shown under the same tag IS a new signal and has to start its clock
 * again: same id, different key, the old timer is dropped and a fresh one is
 * armed.
 */

/** The two timer calls, injected so the scheduling can be tested without a DOM. */
export interface BannerTimerApi {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface TimedBanner {
  id: string;
  /** Strictly increasing at every show: it is what makes a re-show a new clock. */
  shownAt: number;
}

const domTimers: BannerTimerApi = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (handle) => clearTimeout(handle),
};

function timerKey(b: TimedBanner): string {
  return `${b.id}@${b.shownAt}`;
}

export interface SyncBannerTimersOptions {
  ttlMs: number;
  onExpire: (id: string) => void;
  timers?: BannerTimerApi;
}

/**
 * Align `handles` with `banners`: arm what is new, keep what is already
 * running, cancel what is gone. Idempotent, so calling it at every render is
 * free.
 */
export function syncBannerTimers(
  banners: readonly TimedBanner[],
  handles: Map<string, number>,
  { ttlMs, onExpire, timers = domTimers }: SyncBannerTimersOptions,
): void {
  const live = new Set(banners.map(timerKey));
  for (const [key, handle] of handles) {
    if (!live.has(key)) {
      timers.clear(handle);
      handles.delete(key);
    }
  }
  for (const banner of banners) {
    const key = timerKey(banner);
    if (handles.has(key)) continue;
    handles.set(
      key,
      timers.set(() => {
        handles.delete(key);
        onExpire(banner.id);
      }, ttlMs),
    );
  }
}

/** Unmount: nothing left ticking against a component that no longer exists. */
export function clearBannerTimers(handles: Map<string, number>, timers: BannerTimerApi = domTimers): void {
  for (const handle of handles.values()) timers.clear(handle);
  handles.clear();
}
