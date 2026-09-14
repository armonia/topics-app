/**
 * Where a shared page goes when it does not fit the pane that shows it.
 *
 * Since the viewport of a shared browser context belongs to whoever is using it
 * (TOPIC-BROWSER-05), every other viewer watches a page whose size is not its
 * own: a phone looking at a 1280x800 desktop page, or a Mac looking at a page a
 * phone just took down to 390x700. The page is scaled to fit and CENTRED, and
 * what is left over is theme background. Pinned top-left it read as a broken
 * pane rather than a scaled one.
 *
 * Extracted from the component because this is the part with an answer that can
 * be wrong, and it should be able to fail in a test without a DOM.
 */
export interface Fit {
  /** Uniform scale to apply to the page, never above 1:1 downscale semantics. */
  scale: number;
  /** Left offset of the scaled page inside the container, in container px. */
  left: number;
  /** Top offset of the scaled page inside the container, in container px. */
  top: number;
}

export function fitCentered(
  container: { width: number; height: number },
  page: { width: number; height: number },
): Fit {
  const { width: cw, height: ch } = container;
  const { width: pw, height: ph } = page;
  // Nothing measured yet (a pane still laying out, a page before its first
  // frame): 1:1 at the origin, so the caller paints something rather than
  // dividing by zero.
  if (!(cw > 0 && ch > 0 && pw > 0 && ph > 0)) return { scale: 1, left: 0, top: 0 };
  const scale = Math.min(cw / pw, ch / ph);
  return {
    scale,
    left: Math.max(0, Math.round((cw - pw * scale) / 2)),
    top: Math.max(0, Math.round((ch - ph * scale) / 2)),
  };
}

/** rrweb event types/sources we read the page size from. Kept here with the fit
 *  so the two halves of "how big is the page" stay in one place. */
const EVENT_META = 4;
const EVENT_INCREMENTAL = 3;
const INCREMENTAL_VIEWPORT_RESIZE = 4;

/** Minimal shape of the rrweb events that carry a page size. */
export interface RrwebSizeEvent {
  type: number;
  data?: { width?: number; height?: number; source?: number };
}

/**
 * The page size an rrweb event announces, or `null` if it announces none.
 *
 * Meta only says how big the page was when RECORDING STARTED. A shared context
 * changes size whenever its driver changes (TOPIC-BROWSER-05), and rrweb says so
 * with an IncrementalSnapshot of source ViewportResize. Reading only Meta left
 * every other viewer fitting the first size forever, so the mirror was scaled
 * wrong for the rest of the session.
 */
export function viewportFromRrwebEvent(
  event: RrwebSizeEvent | null | undefined,
): { width: number; height: number } | null {
  if (!event || !event.data) return null;
  const carries =
    event.type === EVENT_META ||
    (event.type === EVENT_INCREMENTAL && event.data.source === INCREMENTAL_VIEWPORT_RESIZE);
  if (!carries) return null;
  const { width, height } = event.data;
  if (!width || !height) return null;
  return { width, height };
}
