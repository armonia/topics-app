// THE FRONT DOOR of every deep-link click, and the only one.
//
// WHAT LIVES HERE. The entry points a CLICK arrives at: the native banner
// delegate, the service-worker message of a web-push, the bell history, and the
// boot-time URL. They all end up in `openDeepLinkInApp`, so the rule ("task,
// then topic, then nothing", plus the detached-window guard) is written once.
//
// WHY IT IS NOT IN `openTaskLink.ts`, where it used to sit. These functions need
// BOTH layers: the task-URL primitives below (`openTaskLink`) and the single
// gate above (`tabLink.openTabInApp`), which owns the existence check. Since
// `tabLink` already imports `openTaskLink`, putting the front door in the lower
// module made the two import each other. A cycle in ESM is not an error until
// one side reads a binding of the other at module-evaluation time, and then it
// is a `Cannot access before initialization` at boot: the repo forbids them
// outright (tests/unit/no-import-cycles.test.ts, whose derogation list is
// deliberately empty). The front door is simply the HIGHER layer of the two, so
// it gets its own module and both cycles disappear by construction.

import { openTabInApp, type OpenTabOptions } from './tabLink';
import { openExternalOnce } from './openExternal';
import { isDetachedWindow } from './windowRole';
import {
  currentTaskTarget,
  openTaskInApp,
  parseTopicLocation,
  selfTaskLinkTarget,
  selfTopicLinkTarget,
  type TopicTarget,
} from './openTaskLink';

/** How the NOTIFICATION deep-links say they have no destination.
 *
 *  The toast is a React context and these surfaces are pure modules (the native
 *  banner delegate, the service-worker listener, the bell-history hook): none of
 *  them can call `useToast()` where the click actually lands. Whoever has the
 *  provider above it registers the channel - `BootDeepLinkResolver`, already the
 *  home of the dead-permalink toast - and from there it covers all three.
 *  Without this channel, closing the ghost-tab hole would only have moved the
 *  defect from "opens an empty tab" to "nothing happens". */
let deepLinkNotifier: ((message: string) => void) | null = null;

/** Register the warning channel and return its canceller (used from a React
 *  effect under `<ToastProvider>`). Last one mounted wins. */
export function setDeepLinkNotifier(notify: (message: string) => void): () => void {
  deepLinkNotifier = notify;
  return () => { if (deepLinkNotifier === notify) deepLinkNotifier = null; };
}

/** Open (or unarchive + open) the TOPIC tab, IN-APP.
 *
 *  A typed ALIAS of the single gate: `/topic/<id>` and `/tab/chat/<id>` are two
 *  names for the same destination, so they must travel the same road. Until
 *  this card this function emitted a BARE `topics:open-topic`, and that event is
 *  CREATIVE: `usePanelLifecycle` calls `ensurePaneRegistered` without asking
 *  anybody, and a topicId that no longer exists is a UUID with no record, which
 *  the validation effect keeps FOREVER (optimism). So clicking a notification
 *  for a deleted topic minted an empty chat tab, persisted into `pane-store-v2`
 *  and propagated to every device, while the SAME link written in a chat
 *  answered `DEAD_TAB_MESSAGE`. Two roads to one destination, opposite outcomes.
 *
 *  `openTabInApp` already owns the existence check (`routeIfSubjectExists`),
 *  emits the same `topics:open-topic` with `mode: 'permanent'` (a permalink is a
 *  wanted destination, not a preview) and knows how to say no. */
export function openTopicInApp(target: TopicTarget, opts?: OpenTabOptions): void {
  openTabInApp({ kind: 'chat', key: target.topicId }, {
    ...opts,
    notify: opts?.notify ?? deepLinkNotifier ?? undefined,
  });
}

/**
 * Open the destination of a notification IN-APP. ONE rule for every surface
 * that has a click to take somewhere: the web-push (through the service
 * worker), the native banner, and the notification HISTORY, which would
 * otherwise be the third copy of the same `if`.
 *
 * Takes both an absolute URL (what the service worker hands over) and the
 * relative path the log stores (`/task/<id>`, `/topic/<id>`): `new URL`
 * resolves the second against the page origin, which is already ours.
 *
 * Returns `false` when there is nothing to open, so a history row with no
 * target can say so instead of faking a click that does nothing.
 *
 * THE DETACHED-WINDOW GUARD lives here and not in the three callers, because
 * this is the common gate: the native banner (`openNotifyToken`), the bell
 * history and the service worker all come through. Inside a pop-out
 * (`?topics=`) routing does TWO kinds of damage at once: pane-store persistence
 * is switched off there on purpose, so a pane opened by a deep-link is saved by
 * nobody; and the URL reflection does `u.search = ''`, which wipes `?topics=`,
 * that is the IDENTITY of the window (`lib/windowRole`). On the first reload the
 * pop-out would reopen the whole workspace. The fallback is the one
 * `deepLinkClickRoute` already picks for detached windows: the destination opens
 * OUTSIDE, where it can at least be seen. A click that neither acts nor speaks
 * stays the worst of the three outcomes.
 */
export function openDeepLinkInApp(url: string, opts?: OpenTabOptions): boolean {
  const task = selfTaskLinkTarget(url);
  const topic = task ? null : selfTopicLinkTarget(url);
  if (!task && !topic) return false;
  if (isDetachedWindow()) { forwardDeepLinkOutOfDetachedWindow(url); return true; }
  if (task) { openTaskInApp(task); return true; }
  if (topic) openTopicInApp(topic, opts);
  return true;
}

/** The pop-out neither routes nor touches its own URL: it hands the deep-link
 *  OUTSIDE, resolved against the absolute origin - the system browser on the
 *  desktop shell, a fresh tab of the main window on the web. */
function forwardDeepLinkOutOfDetachedWindow(url: string): void {
  try {
    openExternalOnce(new URL(url, window.location.origin).toString());
  } catch {
    /* no `window`, no origin: there is nowhere to forward to */
  }
}


// ── Service worker → app (a click on a web-push) ──────────────────────

/** The channel with `public/sw.js`: a click on a notification cannot navigate
 *  the window (it would reload the SPA), so the SW sends the destination here. */
export const SW_OPEN_URL_MESSAGE = 'topics:open-url';

/** A click on a web-push arrives as a postMessage from the service worker,
 *  because with a window already open the SW focuses it but can NOT carry it
 *  there without reloading. Here the URL goes back to being an ordinary
 *  deep-link and opens the drawer in-app, the same road as a `/task/<id>` link
 *  copied by hand.
 *
 *  Silent about everything else: a URL that is not a deep-link only means
 *  "bring the user to the top", and the window is already focused. */
export function subscribeServiceWorkerTaskOpen(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const handler = (ev: MessageEvent) => {
    const data = ev.data as { type?: string; url?: string } | null;
    if (!data || data.type !== SW_OPEN_URL_MESSAGE || typeof data.url !== 'string') return;
    // The rule ("task, then topic, then nothing") lives in `openDeepLinkInApp`:
    // the notification history must land EXACTLY where the notification that
    // produced it lands, and two copies of the same `if` drift apart.
    openDeepLinkInApp(data.url);
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/** Called once at boot (App). If the URL carries a deep-link (new `/task/<id>`
 *  path or legacy `?task=`), ACTIVATE the global board and hand it the target.
 *  The location is NOT stripped: the URL stays the source of truth (a refresh
 *  recovers the drawer; the board reads `currentTaskTarget()` on mount whenever
 *  it activates), cleared only when the drawer closes.
 *
 *  Emits a live `topics:open-task` for a board already open, and
 *  `topics:open-utility` (board) which usePanelLifecycle turns into a
 *  hydrate-surviving deep-link intent so the board actually becomes active. */
export function openTaskFromUrl(): void {
  const target = currentTaskTarget();
  if (target) { openTaskInApp(target); return; }
  // From a CLOSED window the service worker opens the app straight on
  // `/topic/<id>` (the end-of-chat push): at boot we read that deep-link too.
  const topic = parseTopicLocation(window.location.pathname);
  if (topic) openTopicInApp(topic);
}
