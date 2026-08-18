/**
 * Which entry of the native did-fail queue may still light the error strip.
 *
 * WHY THIS EXISTS. `browser_take_nav_errors` is a DRAIN: reading empties the
 * queue. While the window is visible the 1 s poll keeps it drained, so anything
 * it reads is at most one second old and needs no judgement. Gating that poll on
 * document visibility (idle-frame budget) changed that: while the window is
 * hidden nothing drains, so the queue accumulates for the whole hidden period
 * and the catch-up read on un-hide can surface a failure the pane has long since
 * navigated away from. Measured consequence: an agent-driven navigation fails in
 * a hidden window, the agent then navigates somewhere good, the user un-hides
 * and gets an error strip over a page that is loading fine, with a Retry button
 * pointing at the dead URL.
 *
 * THE RULE, and it applies ONLY to the catch-up read. `fresh === null` means
 * "the queue was drained a beat ago, nothing here can be stale" and reproduces
 * the pre-gating behaviour exactly. With a `fresh` basis the entry survives only
 * when its URL is one the pane is still about: either the last URL this client
 * asked the view to load (`requested` — every user, agent and restore-driven
 * navigation goes through the hook's `navigate`/open door) or the last URL the
 * native KVO drain reported (`view` — an in-page link the client never
 * requested).
 *
 * Dropping an entry that matches NEITHER is deliberate even when the failure was
 * genuine: after a hidden period, an error about a URL the view no longer points
 * at is history, and the strip claims something about the page on screen NOW.
 */

/** One entry of the Rust did-fail queue, as `browser_take_nav_errors` sends it. */
export interface NativeNavError {
  url: string;
  description: string;
  code: number;
}

/** The two URLs a catch-up read is allowed to accept an error for. */
export interface NavErrorFreshness {
  /** Last URL this client asked the view to load (`navigate` / open). */
  requested: string;
  /** Last URL the native nav-state drain reported for the view. */
  view: string;
}

/**
 * Compare two URLs the way "is the pane still about this?" means it.
 *
 * The failing URL comes from Cocoa (`NSErrorFailingURLStringKey`) and the
 * requested one from `normalizeUrl`, so the same target can differ by a trailing
 * slash on the root path, by case in the host, or by a fragment the network
 * layer never saw. Anything unparseable falls back to a trimmed string compare
 * rather than throwing: an entry we cannot canonicalise must still be comparable.
 */
function sameTarget(a: string, b: string): boolean {
  if (!a || !b) return false;
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(u: string): string {
  const raw = u.trim();
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

function asNavError(e: unknown): NativeNavError | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as { url?: unknown; description?: unknown; code?: unknown };
  if (typeof o.url !== 'string') return null;
  return {
    url: o.url,
    description: typeof o.description === 'string' ? o.description : '',
    code: typeof o.code === 'number' ? o.code : 0,
  };
}

/**
 * The newest entry that may still light the strip, or null.
 *
 * @param events the raw drain payload (anything not an array is "nothing")
 * @param fresh  the catch-up basis, or null/undefined for the live poll
 */
export function pickNavError(
  events: unknown,
  fresh?: NavErrorFreshness | null,
): NativeNavError | null {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = asNavError(events[i]);
    if (!e) continue;
    if (!fresh) return e;
    // No basis at all (a pane that has never navigated and never been told a
    // URL): judging would mean dropping every error forever, so accept.
    if (!fresh.requested && !fresh.view) return e;
    if (sameTarget(e.url, fresh.requested) || sameTarget(e.url, fresh.view)) return e;
  }
  return null;
}
