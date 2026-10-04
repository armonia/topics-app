/**
 * MOVING AN IFRAME IN THE DOM RELOADS IT. THIS MODULE IS WHY WE NEVER MOVE ONE.
 *
 * Dragging a browser tab from one group to another hands its pane to a different
 * React instance, so the subtree is detached from the source and re-attached
 * under the destination. For almost every node that is free; for an `<iframe>` it
 * is not. Detaching one discards its browsing context, and the browser builds a
 * new one on re-attach: the page loads again and the user's scroll, forms, media
 * and in-page session go with it. There is no flag for this - it is what the
 * platform does, whether React recreates the element or merely re-parents the
 * same one.
 *
 * Measured before this module existed, on one cross-group drag
 * (`tests/e2e/tab-reposition-no-reload.spec.ts`, REORD-03): 1 shell detach,
 * 1 iframe `load`, 1 spinner - with `iframeMounts: 0`, which is the tell that
 * React MOVED the very element rather than rebuilding it. The element survived
 * and the page still reloaded.
 *
 * So the frame stops living in the pane. It lives here, in one fixed layer that
 * belongs to the document and never moves, and the pane only lends it a
 * rectangle. This is the same trade the Tauri shell already makes for native
 * WKWebViews - composited over the UI, positioned by the layout slot - and the
 * refcount below is the same idiom as `useTauriBrowser`'s `browserViewRefs`,
 * grace included: a cross-group move unmounts and remounts within the same
 * gesture, and without the grace the frame would be torn down between the two.
 *
 * WHAT THIS DOES NOT NEED. The native path has to fight occlusion, because a
 * native webview composites above every HTML overlay no matter the z-index
 * (`lib/shell/browserOcclusion.ts`). An iframe is HTML and obeys z-index like
 * anything else, so the layer simply sits below the band where overlays start
 * (menus and tooltips at 100, dialogs above) and nothing has to freeze.
 */

/** The layer's z-index. Overlays in this app start at 60 (`z-[60]`), so anything
 *  that can float over a pane - menu, popover, tooltip, dialog - already wins. */
const LAYER_Z = 1;

/** How long a frame outlives its last pane. A cross-group drag unmounts the old
 *  pane and mounts the new one in the same gesture; this window is what makes
 *  those two events one frame instead of two. Same value, same reason, as
 *  `BROWSER_CLOSE_GRACE_MS` in `useTauriBrowser`. */
const RELEASE_GRACE_MS = 350;

/** How long the frame stays PAINTED after its last pane let go. Short enough
 *  that closing a tab does not leave a page hanging over the layout, long
 *  enough that the unmount/mount pair of a cross-group move never shows a gap. */
const HIDE_GRACE_MS = 48;

/**
 * THE FRAME'S OWN STEPS, the part of the tab's history the server never sees.
 *
 * The pane's ‹ and › move the server-side browser's history, and the frame
 * follows the address the server announces. A link clicked INSIDE the framed
 * page is a navigation of a cross-origin document: the server does not hear of
 * it, so moving the server's history from there jumps to whatever the server
 * had before - measured, ‹ after a link showed the page before the one the link
 * left. What the user expects is the page the link left.
 *
 * The frame's `history` is not readable from here (cross-origin), but the
 * browser keeps ONE session history for the document and its frames, so
 * `window.history.back()` takes the frame back when the newest entry is the
 * frame's. These counters say how many such entries are behind and ahead.
 *
 * - `back` / `forward`: in-page steps that ‹ / › can still undo or redo.
 * - `expect`: the next `load` is one we started (our own address, or a step
 *   taken through the session history) and must not be counted as a new step.
 * - `seenLength`: `history.length` at the last load we looked at. A load that
 *   made it grow added an entry: that is a link, not a reload or a
 *   `location.replace` redirect, which add nothing.
 * - `appHref`: the app's own address when the steps were counted. If the app
 *   has pushed a route since (a /task/ permalink), the newest entries are the
 *   app's and `history.back()` would close the drawer instead of moving the
 *   page, so the steps are dropped and ‹ goes back to the server's history.
 */
interface FrameSteps {
  back: number;
  forward: number;
  expect: boolean;
  seenLength: number;
  appHref: string;
}

interface Hosted {
  readonly wrapper: HTMLDivElement;
  readonly iframe: HTMLIFrameElement;
  refs: number;
  url: string;
  steps: FrameSteps;
}

/** Fresh counters for a frame about to load an address WE chose. */
function ownLoad(): FrameSteps {
  return {
    back: 0,
    forward: 0,
    expect: true,
    seenLength: window.history.length,
    appHref: window.location.href,
  };
}

/** Counts the frame's loads: ours are skipped, a link adds a step. */
function onFrameLoad(entry: Hosted): void {
  const s = entry.steps;
  const length = window.history.length;
  const grew = length > s.seenLength;
  s.seenLength = length;
  if (s.expect) {
    s.expect = false;
    return;
  }
  // A link after a ‹ replaces the entries ahead without growing the history:
  // still a new step, and the old ones ahead are gone.
  if (grew || s.forward > 0) {
    s.back += 1;
    s.forward = 0;
    s.appHref = window.location.href;
  }
}

/**
 * Takes one of the frame's own steps, if it has one: `true` when ‹/› was
 * handled here, `false` when the server's history is the one to move.
 */
export function stepHostedFrame(contextId: string, direction: 'back' | 'forward'): boolean {
  const entry = hosted.get(contextId);
  if (!entry) return false;
  const s = entry.steps;
  if (s.appHref !== window.location.href) {
    s.back = 0;
    s.forward = 0;
    return false;
  }
  if (direction === 'back' ? s.back < 1 : s.forward < 1) return false;
  if (direction === 'back') {
    s.back -= 1;
    s.forward += 1;
  } else {
    s.forward -= 1;
    s.back += 1;
  }
  s.expect = true;
  s.seenLength = window.history.length;
  if (direction === 'back') window.history.back();
  else window.history.forward();
  return true;
}

/**
 * Sends an existing frame to `url` WITHOUT adding an entry to the session
 * history. Assigning `src` to a frame already in the document is a 'push'
 * navigation: every address typed in the sheet and every ‹/› of the tab added
 * an entry to the APP's history, so the browser's Back after a ‹ took the frame
 * to the page the tab had just left (label and page disagreeing) and buried the
 * app's own entries. `location.replace` is callable on a cross-origin frame.
 */
function navigateFrame(entry: Hosted, url: string): void {
  entry.url = url;
  entry.steps = ownLoad();
  const win = entry.iframe.contentWindow;
  if (win) win.location.replace(url);
  else entry.iframe.src = url;
}

const hosted = new Map<string, Hosted>();
const pendingRelease = new Map<string, ReturnType<typeof setTimeout>>();
const pendingHide = new Map<string, ReturnType<typeof setTimeout>>();
let layer: HTMLDivElement | null = null;

/**
 * WHILE A PANE IS BEING DRAGGED, OR A TAB SHEET COVERS IT, THE LAYER STEPS ASIDE.
 *
 * Dropping a tab onto a pane body is how panes merge into one group, and the
 * target of that drop is an overlay the pane renders over itself
 * (`Layout/DropOverlay`, `data-grid-split-overlay="center"`). That overlay used
 * to cover the frame because the frame was its sibling; now the frame is in a
 * layer of its own, above it, and an `<iframe>` under the cursor takes the drop
 * for itself - the app never hears about it.
 *
 * Measured when this was missing: all three cases of
 * `tab-reposition-no-reload.spec.ts` failed at the SAME step, the merge, with
 * the drop simply never arriving.
 *
 * `dragstart` only reaches this document for a drag that started in it: a page
 * dragging something inside the frame is its own business and never gets here.
 *
 * The tab sheet (`BrowserTabSheetBody`) asks for the same thing for the same
 * reason: a click on a frame is dispatched to the frame's document, so while
 * the sheet is open "a click on the page closes the sheet" needs the click to
 * land on the app instead.
 */
export function setFramesInteractive(interactive: boolean): void {
  for (const { wrapper } of hosted.values()) {
    wrapper.style.pointerEvents = interactive ? 'auto' : 'none';
  }
}

let dragPassThroughArmed = false;
function armDragPassThrough(): void {
  if (dragPassThroughArmed) return;
  dragPassThroughArmed = true;
  // Capture phase: the app's own handlers must not be able to stop this, and
  // `drop`/`dragend` are the two ways a gesture ends - a drag cancelled with
  // Escape fires `dragend`, so no path leaves the frames deaf.
  document.addEventListener('dragstart', () => setFramesInteractive(false), true);
  document.addEventListener('dragend', () => setFramesInteractive(true), true);
  document.addEventListener('drop', () => setFramesInteractive(true), true);
}

function hostLayer(): HTMLDivElement {
  if (layer?.isConnected) return layer;
  const el = document.createElement('div');
  el.setAttribute('data-browser-frame-layer', '');
  // `pointer-events: none` on the layer, `auto` on each frame: the empty space
  // between frames must not eat clicks meant for the app underneath.
  el.style.cssText =
    `position:fixed;inset:0;pointer-events:none;z-index:${LAYER_Z};`;
  document.body.appendChild(el);
  layer = el;
  armDragPassThrough();
  return el;
}

/** Two spellings of one address (`https://a.b` and `https://a.b/`) are the
 *  same page: comparing the parsed form keeps a remount from reloading it. */
function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * The frame for `contextId`, created on first use and reused afterwards.
 *
 * `src` is written once, at creation. The frame is navigated again only when
 * the pane's address becomes a DIFFERENT one, and then with `location.replace`
 * (`navigateFrame`). Any navigation is the reload this module exists to avoid,
 * so a remount that hands back the address the frame already has (a
 * cross-group move) leaves it alone.
 *
 * A different address is a navigation the pane asked for: an address typed in
 * the tab's sheet, its ‹ and ›. Until 2026-10-04 the frame was never navigated
 * after creation, so after the first page every one of those changed the tab's
 * label and nothing else: the frame kept showing the first page, and ‹ looked
 * dead (`tests/e2e/browser-back.spec.ts`).
 */
export function retainHostedFrame(contextId: string, url: string): HTMLIFrameElement {
  for (const timers of [pendingRelease, pendingHide]) {
    const pending = timers.get(contextId);
    if (pending !== undefined) {
      clearTimeout(pending);
      timers.delete(contextId);
    }
  }
  const existing = hosted.get(contextId);
  if (existing) {
    existing.refs += 1;
    if (!sameAddress(existing.url, url)) navigateFrame(existing, url);
    return existing.iframe;
  }

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;overflow:hidden;pointer-events:auto;display:none;';
  wrapper.setAttribute('data-browser-frame-for', contextId);

  const iframe = document.createElement('iframe');
  iframe.title = 'Web page';
  iframe.setAttribute('data-testid', 'browser-iframe');
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
  // The same sandbox the inline frame carried, and for the same reason: without
  // it a framed app can `top.location = …` and navigate the whole host away from
  // Topics. Omitting `allow-top-navigation*` blocks that while leaving scripts,
  // forms, storage and OAuth popups working.
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
  );
  iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
  iframe.src = url;

  const entry: Hosted = { wrapper, iframe, refs: 1, url, steps: ownLoad() };
  iframe.addEventListener('load', () => onFrameLoad(entry));
  wrapper.appendChild(iframe);
  hostLayer().appendChild(wrapper);
  hosted.set(contextId, entry);
  return iframe;
}

/** Drops one reference. The frame is destroyed only when the last one goes and
 *  the grace expires with nobody having asked for it again. */
export function releaseHostedFrame(contextId: string): void {
  const entry = hosted.get(contextId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  // NOT HIDDEN ON THE SPOT, and this is the difference between a move that is
  // invisible and one that blinks. A cross-group move is an unmount followed by
  // a mount, and between the two there is a moment with no pane holding the
  // frame: hiding it there uncovers the shell underneath, which at that instant
  // is a pane still working out its URL - a loader. Measured: `spinners: 1` on
  // REORD-03 with the immediate hide, 0 without it.
  //
  // A pane that closed for real must not leave its page floating over the
  // reflowed layout either, so the hide still comes - just late enough that a
  // remount beats it. Both timers die on the next `retain`.
  pendingHide.set(
    contextId,
    setTimeout(() => {
      pendingHide.delete(contextId);
      const current = hosted.get(contextId);
      if (current && current.refs <= 0) current.wrapper.style.display = 'none';
    }, HIDE_GRACE_MS),
  );
  pendingRelease.set(
    contextId,
    setTimeout(() => {
      pendingRelease.delete(contextId);
      const current = hosted.get(contextId);
      if (!current || current.refs > 0) return;
      current.wrapper.remove();
      hosted.delete(contextId);
      if (hosted.size === 0 && layer?.isConnected) {
        layer.remove();
        layer = null;
      }
    }, RELEASE_GRACE_MS),
  );
}

/** Puts the frame over `rect`, or hides it when there is nothing to cover.
 *  A zero-area rect IS the hidden case: that is what a collapsed cell (pane
 *  zoom) or a `display:none` background tab measures. */
export function placeHostedFrame(contextId: string, rect: DOMRect | null): void {
  const entry = hosted.get(contextId);
  if (!entry) return;
  const { wrapper } = entry;
  if (!rect || rect.width < 1 || rect.height < 1) {
    if (wrapper.style.display !== 'none') wrapper.style.display = 'none';
    return;
  }
  const next = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
  // Write only on a real change: this runs on every scroll and on a poll, and an
  // unconditional style write on an iframe's ancestor is a layout invalidation
  // the frame pays for.
  if (wrapper.dataset.at !== next) {
    wrapper.dataset.at = next;
    wrapper.style.left = `${Math.round(rect.left)}px`;
    wrapper.style.top = `${Math.round(rect.top)}px`;
    wrapper.style.width = `${Math.round(rect.width)}px`;
    wrapper.style.height = `${Math.round(rect.height)}px`;
  }
  if (wrapper.style.display !== 'block') wrapper.style.display = 'block';
}
