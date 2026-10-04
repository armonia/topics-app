/**
 * The streaming pane's back/forward flags, as the server reports them in its
 * `nav` messages (`server/browser-nav-history.ts`).
 *
 * Absent means UNKNOWN, never "no": an older server does not send them, and a
 * failed read on a newer one sends a message without them. Unknown keeps what
 * the pane already had, and a pane that never heard them keeps both arrows
 * enabled, which is how the streaming pane behaved before the flags existed.
 */

export interface StreamNavHistory {
  canGoBack?: boolean;
  canGoForward?: boolean;
}

/** Only the flags the source really carries, as booleans. Anything else (a
 *  missing field, a JSON body from an older server) contributes nothing, so
 *  spreading the result can never erase a value the pane already holds. */
export function historyFlagsOf(source: { canGoBack?: unknown; canGoForward?: unknown } | null | undefined): StreamNavHistory {
  const out: StreamNavHistory = {};
  if (typeof source?.canGoBack === 'boolean') out.canGoBack = source.canGoBack;
  if (typeof source?.canGoForward === 'boolean') out.canGoForward = source.canGoForward;
  return out;
}

/**
 * A `history` update: the page moved without a load (or only its history did).
 * Moves the url and the flags and touches nothing else: no loading state, no
 * console rows, because no new document arrived. Returns the SAME object when
 * nothing changes, so a repeated update costs no render.
 */
export function applyHistoryUpdate<S extends StreamNavHistory & { url: string }>(
  state: S,
  update: { url: string; canGoBack?: boolean; canGoForward?: boolean },
): S {
  const flags = historyFlagsOf(update);
  const url = update.url || state.url;
  const unchanged = url === state.url
    && (flags.canGoBack === undefined || flags.canGoBack === state.canGoBack)
    && (flags.canGoForward === undefined || flags.canGoForward === state.canGoForward);
  return unchanged ? state : { ...state, url, ...flags };
}

/** What an arrow shows: the server's answer when there is one, enabled when
 *  there is none (see the header). */
export function arrowEnabled(flag: boolean | undefined): boolean {
  return flag ?? true;
}
