/**
 * The page-state polls of the native browser pane, built from ONE set of
 * fragments.
 *
 * WKWebView's navigation-delegate events aren't bridged to the client, so
 * everything the chrome shows about the page — address bar, tab title, favicon,
 * the loading bar — is read back by evaluating a small script in the page. There
 * are two cadences, because a pane the user is looking at and a pane sitting in
 * a background tab want different things:
 *
 *  - READ  (800ms, visible pane): everything, plus the focus-bump counter and a
 *    drain of the in-page console buffer.
 *  - META (2.5s, hidden pane): the cheap subset — no console drain, no focus
 *    bump, because nobody is clicking in a pane they can't see.
 *
 * They used to be two independently hand-written strings, and they had drifted:
 * only READ carried `readyState`, only META had a `try/catch`. That divergence
 * is what made a pane that went to the background WHILE LOADING stay "loading"
 * for the rest of its life — the one poll that could clear the flag was the one
 * that had just been switched off. The spinner on its tab kept turning, and
 * `useReportBrowserActivity` kept reporting the pane as busy into the project
 * rollup. Built from shared fragments, a field can no longer exist in one poll
 * and not the other.
 *
 * `readyState` and the document's inline `zoom` are in BOTH for the same reason:
 * they are the two facts the host must keep re-checking because the page can
 * lose them on its own (a navigation replaces the document), and a pane doesn't
 * stop navigating just because it's in a background tab.
 */

import type { BrowserConsoleEntry } from '@/components/Browser/browserDevTypes';

/** One console line drained from the in-page proxy. */
export interface PageConsoleLine {
  level: BrowserConsoleEntry['level'];
  text: string;
}

/** What a poll tick learns about the page. */
export interface PageState {
  /** `location.href`, or '' when the page reports `about:blank`. */
  url: string;
  title: string;
  favicon: string;
  /** `document.readyState`. The loading bar is driven off this and nothing else. */
  readyState: string;
  /** The inline zoom the DOCUMENT currently carries — '' when it has none.
   *  Compared against the wanted zoom by {@link zoomDrifted}. */
  zoomStyle: string;
  /** Trusted-pointerdown counter (READ only; 0 when the poll doesn't carry it). */
  focusBump: number;
  /** Console lines drained this tick (READ only; empty otherwise). */
  console: PageConsoleLine[];
}

/* ------------------------------------------------------------- fragments -- */

/** Fields every poll carries. Keeping them in one string is the point of this
 *  module: `r` and `z` must never again be present in one poll and missing from
 *  the other. */
const COMMON_FIELDS =
  "u:location.href," +
  "t:document.title," +
  "r:document.readyState," +
  "z:document.documentElement.style.zoom||''," +
  "f:(document.querySelector(\"link[rel~='icon']\")||{}).href||location.origin+'/favicon.ico'";

/** Fields only the foreground poll needs: the click counter and the console
 *  drain (which MUTATES the page-side buffer, so it must not run twice). */
const FOREGROUND_FIELDS =
  "k:window.__topicsFocusBump||0," +
  "c:(window.__topicsConsole?window.__topicsConsole.splice(0,window.__topicsConsole.length):[])";

/**
 * The foreground (800ms) poll. `installFocusHook` is prepended verbatim so
 * whichever poll runs first installs the identical in-page pointerdown hook.
 *
 * Wrapped in try/catch like the background one always was: a page that throws
 * on `document.title` (a cross-origin edge, a document torn down mid-eval) used
 * to reject the whole eval, and the tick's catch-all then swallowed the state
 * that WAS readable.
 */
export function buildReadJs(installFocusHook: string): string {
  return (
    '(function(){try{' + installFocusHook +
    'return JSON.stringify({' + COMMON_FIELDS + ',' + FOREGROUND_FIELDS + '})' +
    "}catch(e){return ''}})()"
  );
}

/** The background (2.5s) poll: the common fields, nothing else. */
export const META_JS =
  "(function(){try{return JSON.stringify({" + COMMON_FIELDS + "})}catch(e){return ''}})()";

/* ---------------------------------------------------------------- parse --- */

/**
 * Parse a poll payload. Returns null for anything unusable (empty string from
 * the in-page catch, malformed JSON, a non-object) so callers have exactly one
 * "nothing to apply this tick" case instead of guarding each field.
 *
 * `about:blank` maps to an EMPTY url on purpose: it is what a freshly-created
 * webview reports before its first real navigation, and showing it in the
 * address bar would overwrite the URL the user just typed.
 */
export function parsePageState(raw: string | null | undefined): PageState | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const rawUrl = str(o.u);
  return {
    url: rawUrl === 'about:blank' ? '' : rawUrl,
    title: str(o.t),
    favicon: str(o.f),
    readyState: str(o.r),
    zoomStyle: str(o.z),
    focusBump: typeof o.k === 'number' ? o.k : 0,
    console: Array.isArray(o.c)
      ? (o.c as PageConsoleLine[]).filter((e) => e && typeof e.text === 'string')
      : [],
  };
}

/**
 * Is the page still loading?
 *
 * The ONLY authority on the loading bar. It used to have two: an optimistic
 * `setLoading(true)` on intent, cleared by a blind `setTimeout(…, 700)`, racing
 * a poll that re-derived it from `readyState` every 800ms. Two clocks 100ms
 * apart writing one boolean is a flicker: the timer switched the progress bar
 * off, the next tick found the page still loading and switched it back on, for
 * as long as the page took. Intent may still SET it — a click should light the
 * bar before the first tick — but only the page's own `readyState` clears it.
 *
 * An empty `readyState` (a poll that couldn't read the document) is NOT
 * "loading": it is "don't know", and it must not light a progress bar.
 */
export function isPageLoading(readyState: string): boolean {
  return readyState !== '' && readyState !== 'complete';
}
