// Browser occlusion — keep HTML overlays above native browser webviews (Tauri).
//
// A native child webview (Tauri multi-webview / Electron WebContentsView) ALWAYS
// composites above the React DOM — no z-index can lift a dropdown/menu/modal over
// it. Electron solves this with separate always-on-top overlay windows
// (electronAPI.overlay / overlayHost). The Tauri shell substitutes a pixel still:
// a pane that an overlay actually covers freezes to a DOM <img> and parks the live
// view, so the overlay composites over the still by normal z-index (see
// useTauriBrowser.freeze).
//
// We track overlays structurally (no edits to every popover primitive): the
// canonical popover is a `.glass-surface` card (lib/popoverStyles), the canonical
// modal card is `.native-occlude` (baked into MODAL_PANEL in lib/modalStyles, so
// EVERY full-screen dialog is covered without opting in per modal), and
// menus/listboxes carry their ARIA roles. A cheap MutationObserver collects their
// RECTS so each pane can decide whether it is actually intersected — a menu
// nowhere near a browser pane must NOT touch it (the old global "any overlay hides
// every pane" was over-broad).

import { isTauri } from './index';

/** Selector matching any HTML overlay that can float over a browser pane.
 *  `[role="tooltip"]` since 2026-09-04: both tooltip components portal a
 *  `role="tooltip"` node at `z-[100]`, and without this entry a hint on a
 *  toolbar button above a browser pane painted UNDER the native webview. The
 *  intersection rule keeps the cost where it belongs: a hint that does not
 *  overlap the pane freezes nothing.
 *  `.native-occlude` is the class MODAL_PANEL carries: marking the opaque modal
 *  CARD (not the semi-transparent backdrop, which the pane shows through anyway)
 *  makes the freeze scope exactly the region the dialog actually covers.
 *  Exported so a unit test can assert real modal/popover class strings still
 *  match it — the structural link that keeps modals above the native pane. */
export const OVERLAY_SELECTOR =
  '.glass-surface, .native-occlude, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-radix-popper-content-wrapper]';

/** Viewport-relative rect of an open overlay. */
export interface OverlayRect { left: number; top: number; right: number; bottom: number; }

let overlays: OverlayRect[] = [];
let lastKey = '';
const listeners = new Set<(overlays: OverlayRect[]) => void>();
/** Live observer handle, or null when nobody is watching. Was a one-way
 *  `started = true`: the first browser pane ever mounted armed a
 *  `document.body` + `subtree:true` MutationObserver that then ran for the rest
 *  of the session — long after that pane was closed, with zero subscribers left
 *  to notify. Every node xterm and the streaming chat add or remove still cost a
 *  queued MutationRecord. Now it is refcounted by `listeners`. */
let observer: MutationObserver | null = null;
let scheduled = false;

/** Coda una rimisura. A livello di modulo perché non la chiede solo
 *  l'observer: anche la FINE di un'animazione d'entrata, che nel DOM non lascia
 *  nessuna traccia da osservare (vedi `watchAnimation`).
 *
 *  Next-task, not 30ms: same-tick mutations still coalesce (the observer
 *  batches, and `scheduled` gates re-entry), but a menu that just opened is
 *  measured immediately. Every ms here is a ms the freshly-opened overlay
 *  spends painting UNDERNEATH the native pane — part of the perceived flash. */
function schedule(): void {
  if (scheduled || !observer) return;
  scheduled = true;
  window.setTimeout(recompute, 0);
}

/**
 * Questo overlay DIPINGE, cioè può coprire una pane nativa?
 *
 * Pura, perché la riga che conta è una sola e per anni ha detto la cosa
 * sbagliata: `opacity === '0'` ⇒ ignoralo. Ma OGNI modale di questa app entra
 * con `command-palette-enter` (0.15s da `opacity: 0`), e il tracciatore misura
 * il pannello nell'istante in cui viene inserito — quando l'animazione è ancora
 * a zero. Misurato in WebKit (il motore della WKWebView) e in Chromium: al primo
 * giro `getComputedStyle(card).opacity` è esattamente `"0"`, con
 * `getAnimations()` già in `running`.
 *
 * Il modale finiva quindi FUORI dal set di overlay, e — questo è il punto che lo
 * rendeva permanente e non un lampeggio — nessuna mutazione successiva lo
 * riportava dentro: le modifiche DENTRO il pannello non contengono un overlay,
 * quindi non fanno scattare un altro giro. La webview nativa restava sopra il
 * modale finché il modale non si chiudeva.
 *
 * La distinzione giusta non è «opaco o trasparente» ma «fermo a zero o in
 * arrivo»: uno zero STABILE è un elemento che davvero non si vede (una row
 * action `opacity-0` in attesa dell'hover); uno zero mentre un'animazione gira
 * è un pannello che sta apparendo — e che fra due frame coprirà la pane.
 */
export function overlayPaints(el: {
  hasRects: boolean;
  visibility: string;
  opacity: string;
  animating: boolean;
}): boolean {
  if (!el.hasRects) return false; // display:none — nessun rettangolo, niente da coprire
  if (el.visibility === 'hidden') return false;
  if (el.opacity === '0') return el.animating;
  return true;
}

/** Le animazioni IN CORSO su questo elemento (entrata, uscita, transizione).
 *  Assente in ambienti senza Web Animations: lì si torna al comportamento
 *  vecchio, che è conservativo nel verso sbagliato ma non peggiore di prima. */
function runningAnimations(node: Element): Animation[] {
  const el = node as Element & { getAnimations?: () => Animation[] };
  if (typeof el.getAnimations !== 'function') return [];
  try {
    return el.getAnimations().filter((a) => a.playState === 'running');
  } catch {
    return [];
  }
}

/** Animazioni già agganciate, per non registrare due volte lo stesso `finished`. */
const watchedAnimations = new WeakSet<Animation>();

/** Rimisura quando l'animazione finisce.
 *
 *  Un overlay che entra non ha ancora la sua geometria definitiva: a metà di
 *  `commandPaletteIn` il pannello è ancora traslato di -12px e scalato a 0.98,
 *  quindi il rettangolo appena raccolto è quello di un posto in cui il modale
 *  non resterà. Nessuna mutazione DOM segna la fine di un'animazione CSS —
 *  senza questo aggancio l'ultimo rettangolo noto sarebbe per sempre quello di
 *  metà transizione. */
function watchAnimation(a: Animation): void {
  if (watchedAnimations.has(a)) return;
  watchedAnimations.add(a);
  const done = (a as Animation & { finished?: Promise<unknown> }).finished;
  if (typeof done?.then !== 'function') return;
  done.then(() => schedule(), () => { /* annullata: l'overlay è sparito, e la rimozione ha già rimisurato */ });
}

function recompute(): void {
  scheduled = false;
  const next: OverlayRect[] = [];
  document.querySelectorAll(OVERLAY_SELECTOR).forEach((el) => {
    const node = el as HTMLElement;
    // Never let a browser pane occlude ITSELF: skip overlays that live inside a
    // native browser slot (e.g. the pane's own responsive size-readout, which is
    // a `.glass-surface` positioned over the slot). Without this, that in-pane
    // chrome rect-overlaps the slot and freezes the live view to a static still
    // that never thaws — a dead/frozen-looking browser. Structural, so any future
    // in-pane glass chrome is covered too.
    if (node.closest('[data-native-browser-slot]')) return;
    const cs = getComputedStyle(node);
    const animations = runningAnimations(node);
    if (!overlayPaints({
      hasRects: node.getClientRects().length > 0,
      visibility: cs.visibility,
      opacity: cs.opacity,
      animating: animations.length > 0,
    })) return;
    for (const a of animations) watchAnimation(a);
    const r = node.getBoundingClientRect();
    if (r.width > 1 && r.height > 1) next.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  });
  const key = next
    .map((r) => `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`)
    .sort()
    .join('|');
  if (key === lastKey) return;
  lastKey = key;
  overlays = next;
  for (const fn of listeners) fn(overlays);
}

/** Pure: does `slot` (viewport-rel x/y/width/height) intersect any of `rects`?
 *  Exported for unit tests; `decideFreeze` applies it to the rects the caller
 *  received from `onOcclusionChange`. */
export function slotIntersectsRects(
  slot: { x: number; y: number; width: number; height: number },
  rects: readonly OverlayRect[],
): boolean {
  if (slot.width <= 0 || slot.height <= 0) return false;
  const r = slot.x + slot.width;
  const b = slot.y + slot.height;
  return rects.some((o) => o.left < r && o.right > slot.x && o.top < b && o.bottom > slot.y);
}

/**
 * La decisione, in una funzione pura: questa pane deve togliersi di mezzo?
 *
 * `slot` è `null` quando la pane NON SA dove sta — nessun rettangolo vivo nel
 * DOM e nessuno in cache. Prima quel caso non faceva niente, ed è il modo in
 * cui un menu finisce sotto una webview nativa senza che nessuno se ne accorga:
 * un silenzio che si vede solo a difetto avvenuto.
 *
 * Nel dubbio si CONGELA. I due errori non si equivalgono: un fermo-immagine di
 * troppo per un istante non lo nota nessuno (i pixel sono gli stessi), mentre
 * un menu invisibile sotto una vista nativa è un pezzo di interfaccia che non
 * si può usare. Si sbaglia dalla parte che si può guardare.
 */
export function decideFreeze(
  slot: { x: number; y: number; width: number; height: number } | null,
  rects: readonly OverlayRect[],
): boolean {
  if (!slot) return rects.length > 0;
  return slotIntersectsRects(slot, rects);
}

/**
 * Il rettangolo VIVO dello slot di una pane browser, letto dal DOM nel momento
 * in cui serve decidere.
 *
 * Prima si decideva sull'ultimo rettangolo CHIESTO alla vista nativa (una
 * cache): non è dove la pane STA, è dove le è stato detto di andare l'ultima
 * volta — e non viene aggiornato quando la vista si parcheggia fuori schermo.
 * Basta una pane che si sposta senza ricommittare i bounds (uno split che si
 * ridimensiona, la sidebar che scivola, un cambio di cella) perché la decisione
 * si prenda su una geometria che non esiste più.
 *
 * Letto dal DOM, i due rettangoli vengono dalla stessa fonte — entrambi
 * `getBoundingClientRect()`, entrambi in pixel CSS relativi al viewport —
 * quindi non possono nemmeno essere in due spazi diversi.
 */
export function liveSlotRect(id: string): { x: number; y: number; width: number; height: number } | null {
  if (typeof document === 'undefined' || !id) return null;
  try {
    const el = document.querySelector(`[data-native-browser-slot="${CSS.escape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  } catch {
    return null;
  }
}

/** Gli overlay aperti ADESSO, per chi deve decidere fuori dal giro delle
 *  notifiche — una pane che si apre, o che torna visibile, mentre un menu è già
 *  aperto: nessun evento arriverà, perché niente sta cambiando. */
export function currentOverlays(): readonly OverlayRect[] {
  return overlays;
}

/** Subscribe to overlay-set changes (open/close/move). The callback gets the
 *  current overlay rects; consumers decide intersection per pane. Returns an
 *  unsubscribe fn. Lazily starts the observer on first subscription (Tauri). */
export function onOcclusionChange(fn: (overlays: OverlayRect[]) => void): () => void {
  listeners.add(fn);
  if (isTauri) startObserver();
  // Lo stato CORRENTE, subito. Chi arriva a menu già aperto non riceverebbe
  // nessuna notifica — non sta cambiando niente, e le notifiche parlano solo di
  // cambiamenti — quindi resterebbe cieco fino alla prossima apertura o
  // chiusura di un overlay: una pane che monta (o si ri-registra a un
  // re-render) sotto un modale aperto ci si disegnava sopra e ci restava.
  // `startObserver` rimisura solo la PRIMA volta: con un'altra pane già
  // iscritta l'observer c'è già e quel giro non avviene.
  fn(overlays);
  return () => {
    listeners.delete(fn);
    // Last browser pane gone → tear the body-wide observer down. Nothing can
    // be occluded when there is no native pane to occlude, and leaving it armed
    // made every DOM mutation in the app pay for a watcher with no audience.
    if (listeners.size === 0) stopObserver();
  };
}

/** Tear down the observer and drop the cached rect set, so a later remount
 *  recomputes from scratch instead of inheriting rects measured in another
 *  layout. Exported for tests; production drives it through the last
 *  unsubscribe. */
export function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  scheduled = false;
  overlays = [];
  lastKey = '';
}

function startObserver(): void {
  if (observer || typeof document === 'undefined') return;

  // Only schedule when an added/removed node could be (or contain) an overlay —
  // skips the constant text-node churn of streaming chat.
  const relevant = (nodes: NodeList): boolean => {
    for (const n of Array.from(nodes)) {
      if (n instanceof Element && (n.matches(OVERLAY_SELECTOR) || n.querySelector(OVERLAY_SELECTOR))) {
        return true;
      }
    }
    return false;
  };

  // An overlay can also CLOSE without unmounting — a menu/dialog toggled via
  // `display:none` / `hidden` / `visibility` / class swap is an ATTRIBUTE change,
  // not a childList change. Without watching those, a hidden overlay stays in the
  // rect set and the pane it covered never thaws (a dead/frozen-looking browser).
  // Gate on `overlays.length > 0` (a tracked overlay may have just been hidden —
  // recompute re-verifies) or a matching target (an overlay just revealed), so the
  // constant class churn of streaming chat with no overlay open costs nothing.
  const attrRelevant = (m: MutationRecord): boolean => {
    const t = m.target;
    if (!(t instanceof Element)) return false;
    return overlays.length > 0 || t.matches(OVERLAY_SELECTOR) || t.querySelector(OVERLAY_SELECTOR) != null;
  };

  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' ? attrRelevant(m) : (relevant(m.addedNodes) || relevant(m.removedNodes))) {
        schedule();
        return;
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
  });
  // Initial state (in case an overlay is already open at subscribe time).
  recompute();
}
