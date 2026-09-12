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

interface Hosted {
  readonly wrapper: HTMLDivElement;
  readonly iframe: HTMLIFrameElement;
  refs: number;
  url: string;
}

const hosted = new Map<string, Hosted>();
const pendingRelease = new Map<string, ReturnType<typeof setTimeout>>();
const pendingHide = new Map<string, ReturnType<typeof setTimeout>>();
let layer: HTMLDivElement | null = null;

/**
 * WHILE A PANE IS BEING DRAGGED, THE LAYER STEPS ASIDE.
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
 */
function setFramesInteractive(interactive: boolean): void {
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

/**
 * The frame for `contextId`, created on first use and reused afterwards.
 *
 * `src` is written ONCE, at creation. Assigning it again - even the same string -
 * is a navigation, which is the reload this module exists to avoid; in-pane
 * navigation goes through the frame's own history, not through this function.
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

  wrapper.appendChild(iframe);
  hostLayer().appendChild(wrapper);
  hosted.set(contextId, { wrapper, iframe, refs: 1, url });
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
