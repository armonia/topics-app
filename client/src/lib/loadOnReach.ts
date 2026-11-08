/**
 * When a list's "show more" row should load the next page by itself: the
 * infinite scroll of the lists that grow downwards (a board column, the
 * notification history, the commit history, the sessions to resume).
 *
 * The row loads when it ENTERS the view, one request at a time. Any change in
 * the row count moves the row (a page that lands, an item that arrives while a
 * page is on its way), so what the observer said before it is stale: the
 * controller asks for a fresh look (`remeasure`) and loads again only if the
 * row is truly still in view (a short page, a tall viewport). Trusting the old
 * answer chained page after page within a frame, before the observer could say
 * the row had gone. A load that failed or brought nothing waits for the reader
 * to leave and come back, instead of asking the server in a loop.
 *
 * Pure on purpose: the React side (`useLoadOnReach`) only feeds it what the
 * IntersectionObserver saw and what the list holds after each render.
 */
export interface ListState {
  /** Is there anything past the last row? */
  more: boolean;
  /** A page is on its way. */
  loading: boolean;
  /** Rows on screen now: the measure of progress between two asks. */
  count: number;
  /** Off while the list must not change under the pointer (a drag in progress). */
  enabled?: boolean;
}

export interface LoadOnReach {
  /** The observer saw the row enter (true) or leave (false) the view. */
  seen(visible: boolean): void;
  /** The list after a render. */
  settle(state: ListState): void;
}

export function loadOnReach(load: () => void, remeasure: () => void): LoadOnReach {
  let visible = false;
  let state: ListState = { more: false, loading: false, count: 0 };
  // The row count when the last page was asked for; null once the reader has come back.
  let askedAt: number | null = null;
  const maybeLoad = () => {
    if (!visible || !state.more || state.loading || state.enabled === false) return;
    if (askedAt !== null && state.count <= askedAt) return;
    askedAt = state.count;
    load();
  };
  return {
    seen(now) {
      if (now && !visible) askedAt = null;
      visible = now;
      maybeLoad();
    },
    settle(next) {
      const moved = next.count !== state.count;
      state = next;
      if (moved && visible) {
        // The list moved the row: wait for the observer's fresh answer before asking again.
        visible = false;
        remeasure();
        return;
      }
      maybeLoad();
    },
  };
}
