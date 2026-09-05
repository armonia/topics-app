/**
 * openLink - the ONE door every clicked link goes through.
 *
 * Topics has a browser inside it, so a link clicked in the chat, in the
 * terminal, on a tool card or on a board preview belongs in a tab of THAT
 * browser, in the window the click happened in. Until this module existed each
 * of those surfaces called `openExternalOnce` directly, and every link handed
 * the user over to the system browser: a window outside the app, the page you
 * were reading left behind. Chrome's rule is the one people already have in
 * their hands: plain click = a tab here, Cmd/Ctrl-click (or middle click) = out
 * of the app.
 *
 * HOW THE DEFAULT LANDS. The renderer surfaces that can host a browser pane
 * (the project window and the standalone group) listen for the cancelable
 * `browser:open-tab` event and CLAIM it synchronously with `preventDefault()`.
 * `dispatchEvent` returning true therefore means "nobody here can host a tab",
 * and the link falls back to the system browser rather than doing nothing: a
 * clicked link that produces no visible effect is the worst of the three
 * outcomes, so it is the one branch this module refuses to have.
 *
 * WHAT NEVER BECOMES A TAB. Non-web schemes (mailto:, tel:, file:, an editor's
 * custom scheme): a browser pane cannot host them, so they keep going out to
 * the OS handler, gesture or not.
 */

import { openExternalOnce } from './openExternal';
import { newBrowserContextId } from '../state/pane/adapters/paneConfig';

/** The event a link click fires at the surfaces able to host a browser tab. */
export const OPEN_TAB_EVENT = 'browser:open-tab';

export interface OpenTabDetail {
  /** Absolute URL to load in the new tab. */
  url: string;
  /** Fresh browser contextId for the tab (one native view per tab). */
  contextId: string;
  /** Chat topic the link was clicked in, when the surface knows it. */
  topicId?: string;
  /** Project the link belongs to (board actions know it, a chat does not). */
  projectPath?: string;
  /** Pane the click came from: the new tab lands in ITS strip. */
  nearPaneId?: string;
}

export interface OpenLinkOptions {
  /** Force the system browser (context-menu action). A modifier gesture gets
   *  here through {@link isExternalLinkGesture}. */
  external?: boolean;
  topicId?: string;
  projectPath?: string;
  nearPaneId?: string;
  /** The element the click happened on. Used to find which WINDOW the link was
   *  clicked in, so the tab opens there and not in a sibling surface. */
  origin?: EventTarget | null;
}

/**
 * Which project window the click came from, read off the DOM.
 *
 * The alternative was threading a topicId through every component that renders
 * markdown (a dozen call sites, most of which have no idea what a topic is).
 * The project window already marks its subtree with `data-project-path` for the
 * tests, and a click event already carries the element: one ancestor walk
 * answers the only question the claim needs.
 */
function projectPathOfClick(origin: EventTarget | null | undefined): string | undefined {
  const el = origin as { closest?: (s: string) => Element | null } | null | undefined;
  if (!el || typeof el.closest !== 'function') return undefined;
  const host = el.closest('[data-project-path]');
  return host?.getAttribute('data-project-path') ?? undefined;
}

/** Cmd/Ctrl-click and middle click mean "not here" in every browser, so they
 *  mean the system browser here. Read it at the call site and pass the result
 *  as `external`. */
export function isExternalLinkGesture(e: {
  metaKey?: boolean;
  ctrlKey?: boolean;
  button?: number;
}): boolean {
  return !!e.metaKey || !!e.ctrlKey || e.button === 1;
}

/** Schemes a browser pane can actually load. Everything else is the OS's job. */
function isWebScheme(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

// Same window as openExternal's guard, for the same reason: one user intent can
// fire the handler twice (double click, a duplicated listener), and two tabs for
// one click is a visible mess. Applied HERE so the in-app branch is covered too.
const DEDUPE_MS = 600;
let lastUrl = '';
let lastAt = 0;

/** Test seam: the dedupe is process-wide state, so a test that opens the same
 *  URL twice on purpose has to be able to forget the first one. */
export function resetOpenLinkDedupeForTest(): void {
  lastUrl = '';
  lastAt = 0;
}

export function openLink(url: string, opts: OpenLinkOptions = {}): void {
  if (!url) return;

  // Absolute from here on: a relative '/api/media?…' either fails in the OS
  // handler or gets hijacked into the app's own origin. Same normalisation
  // openExternalOnce does, done once, before the routing decision.
  try {
    url = new URL(url, window.location.origin).toString();
  } catch {
    /* keep as-is */
  }

  const now = Date.now();
  if (url === lastUrl && now - lastAt < DEDUPE_MS) return;
  lastUrl = url;
  lastAt = now;

  if (opts.external || !isWebScheme(url)) {
    openExternalOnce(url);
    return;
  }

  const detail: OpenTabDetail = {
    url,
    // Fresh per click: a tab is a NEW surface, so it gets its own context and
    // its own native view. Reusing one would navigate the page the user is
    // reading away from under them, which is the bug this whole module is about.
    contextId: newBrowserContextId(),
    topicId: opts.topicId,
    projectPath: opts.projectPath ?? projectPathOfClick(opts.origin),
    nearPaneId: opts.nearPaneId,
  };
  const claimed = !window.dispatchEvent(
    new CustomEvent<OpenTabDetail>(OPEN_TAB_EVENT, { detail, cancelable: true }),
  );
  if (!claimed) openExternalOnce(url);
}
