/**
 * A DOM mirror laid out at this device's own size (BROWSER-DOM-LAYOUT-01..03).
 *
 * The page the Mac hosts keeps the Mac's size, and this device lays its copy
 * out at its own: the page's CSS, media queries included, decides what it
 * looks like here. A pixel stops meaning the same thing on the two sides, so
 * what crosses is content. A tap names the element it landed on and the point
 * inside its box. A scroll names the element at the reading line of what
 * scrolled, a quarter down past fixed and sticky headers, and the point of it
 * there. The Mac reads both the same way (nativeDomHost.ts, LAYOUT_JS).
 */
import type { ScrollAnchor } from '../../../shared/browser-ws-messages';

export type { ScrollAnchor };

/** The ids rrweb gave the page's nodes, as this mirror knows them. */
export interface NodeIds {
  getId(node: Node): number;
  getNode(id: number): Node | null;
}

/** How far into what scrolled its reading line is: under a sticky header, well above the fold. */
const READING_LINE = 0.25;

const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;
const SCROLL_SOURCE = 3;

interface Scroller {
  el: Element;
  top: boolean;
  doc: Document;
}

/** What scrolls for `node`: a document scrolls its scrolling element. */
function scrollerOf(node: Node): Scroller | null {
  const doc = node.nodeType === 9 ? (node as Document) : node.ownerDocument;
  if (!doc) return null;
  const root = doc.scrollingElement ?? doc.documentElement;
  if (node.nodeType === 9 || node === root) return { el: root, top: true, doc };
  return node.nodeType === 1 ? { el: node as Element, top: false, doc } : null;
}

/** Can `s` scroll down here: room to, and a box that scrolls (the page always does). */
function canScroll(s: Scroller): boolean {
  if (!(s.el.scrollHeight - s.el.clientHeight > 0)) return false;
  if (s.top) return true;
  const o = s.doc.defaultView?.getComputedStyle(s.el).overflowY;
  return o === 'auto' || o === 'scroll' || o === 'overlay' || o === 'hidden';
}

/**
 * What scrolls `m` here: what scrolled on the other side, unless it cannot
 * scroll here (a breakpoint gave the scrolling to the page, or took it from
 * it); then the nearest box around `m` that can, else the page.
 */
function scrollerFor(s: Scroller, m: Element | null): Scroller {
  if (canScroll(s) || !m) return s;
  const root = s.doc.scrollingElement ?? s.doc.documentElement;
  for (let e = m.parentElement; e && e !== root; e = e.parentElement) {
    const around = { el: e, top: false, doc: s.doc };
    if (canScroll(around)) return around;
  }
  return { el: root, top: true, doc: s.doc };
}

/** The part of what scrolls that shows, in its document's viewport coordinates. */
function visibleBox(s: Scroller): { left: number; top: number; width: number; height: number } {
  if (s.top) {
    const root = s.doc.documentElement;
    const view = s.doc.defaultView;
    return { left: 0, top: 0, width: root.clientWidth || view?.innerWidth || 0, height: root.clientHeight || view?.innerHeight || 0 };
  }
  const r = s.el.getBoundingClientRect();
  return { left: r.left + s.el.clientLeft, top: r.top + s.el.clientTop, width: s.el.clientWidth, height: s.el.clientHeight };
}

/**
 * How far along its range a scroll is, exactly 0 or 1 at an edge (within a
 * pixel: a fractional scroll stops short of the end). An edge is a place of its
 * own: a page at its top is at its top on both sides, whatever the other
 * layout has at the reading line.
 */
function ratio(pos: number, max: number): number {
  if (!(max > 0) || pos <= 0) return 0;
  return pos >= max - 1 ? 1 : pos / max;
}

/** Is `el` drawn where it is by a fixed or sticky box between it and `stop`? Those do not scroll with the content. */
function pinnedTest(stop: Element, view: Window | null): (el: Element) => boolean {
  const seen = new Map<Element, boolean>();
  return (el) => {
    const path: Element[] = [];
    let pinned = false;
    for (let m: Element | null = el; m && m !== stop; m = m.parentElement) {
      const known = seen.get(m);
      if (known !== undefined) { pinned = known; break; }
      path.push(m);
      const position = view?.getComputedStyle(m).position;
      if (position === 'fixed' || position === 'sticky') { pinned = true; break; }
    }
    for (const m of path) seen.set(m, pinned);
    return pinned;
  };
}

/** Where `node` (a document or an element) is scrolled to, named by its content. */
export function anchorOf(node: Node, ids: NodeIds): ScrollAnchor | null {
  const s = scrollerOf(node);
  if (!s) return null;
  const { el, doc } = s;
  const box = visibleBox(s);
  const mx = el.scrollWidth - el.clientWidth;
  const my = el.scrollHeight - el.clientHeight;
  const anchor: ScrollAnchor = {
    lx: mx > 0 ? READING_LINE : 0.5,
    ly: my > 0 ? READING_LINE : 0.5,
    rx: ratio(el.scrollLeft, mx),
    ry: ratio(el.scrollTop, my),
  };
  const px = box.left + anchor.lx * box.width;
  const py = box.top + anchor.ly * box.height;
  const pinned = pinnedTest(el, doc.defaultView);
  for (const e of doc.elementsFromPoint(px, py)) {
    if (e === el || e === doc.body || e === doc.documentElement || (!s.top && !el.contains(e)) || pinned(e)) continue;
    // The nearest element the recorder named: the Mac knows it by that id.
    let m: Element | null = e;
    while (m && m !== el && ids.getId(m) < 0) m = m.parentElement;
    if (!m || m === el || m === doc.body) continue;
    const r = m.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    return { ...anchor, id: ids.getId(m), fx: (px - r.left) / r.width, fy: (py - r.top) / r.height };
  }
  return anchor;
}

/**
 * What has to scroll, and where, for `anchor` to be at the reading line here:
 * `node` (what scrolled on the other side) or the box that scrolls its element
 * here; by its range when that element has no box here, and at an edge the
 * anchor is on.
 */
export function placeOf(node: Node, anchor: ScrollAnchor, ids: NodeIds): { top: number; left: number; el: Element } | null {
  const named = scrollerOf(node);
  if (!named) return null;
  const found = typeof anchor.id === 'number' ? ids.getNode(anchor.id) : null;
  const m = found && found.nodeType === 1 && found.isConnected && found.ownerDocument === named.doc ? (found as Element) : null;
  const s = scrollerFor(named, m);
  const { el } = s;
  const my = Math.max(0, el.scrollHeight - el.clientHeight);
  const mx = Math.max(0, el.scrollWidth - el.clientWidth);
  const place = { top: anchor.ry * my, left: anchor.rx * mx, el };
  if (m && (s.top || el.contains(m))) {
    const r = m.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const box = visibleBox(s);
      if (anchor.ry > 0 && anchor.ry < 1) place.top = el.scrollTop + r.top + (anchor.fy ?? 0) * r.height - (box.top + anchor.ly * box.height);
      if (anchor.rx > 0 && anchor.rx < 1) place.left = el.scrollLeft + r.left + (anchor.fx ?? 0) * r.width - (box.left + anchor.lx * box.width);
    }
  }
  return place;
}

/** The same place, as the Mac sends a viewer's own place back. */
export function sameAnchor(a: ScrollAnchor | null | undefined, b: ScrollAnchor | null | undefined): boolean {
  return !!a && !!b && a.id === b.id && a.fx === b.fx && a.fy === b.fy
    && a.lx === b.lx && a.ly === b.ly && a.rx === b.rx && a.ry === b.ry;
}

/** A replayer's mirror document, or null when this shell will not let it be read (WKWebView + custom scheme). */
export function mirrorDocument(replayer: { iframe?: HTMLIFrameElement } | null | undefined): Document | null {
  try {
    return replayer?.iframe?.contentDocument ?? null;
  } catch {
    return null;
  }
}

/**
 * A tap's payload at a point of the mirror. Laid out on its own, it names what
 * the point is over and where inside it, and a point it cannot name is not
 * sent at all: its pixels are not the Mac's.
 */
export function aimTap<P extends { x: number; y: number }>(
  p: P,
  own: boolean,
  replayer: { iframe?: HTMLIFrameElement; getMirror(): NodeIds } | null | undefined,
): (P & { node?: number; fx?: number; fy?: number }) | null {
  if (!own) return p;
  const doc = mirrorDocument(replayer);
  const target = doc && replayer ? targetOf(doc, p.x, p.y, replayer.getMirror()) : null;
  return target ? { ...p, ...target } : null;
}

/** What a tap at (x, y) of the mirror landed on, by the recorder's id, and where inside its box. */
export function targetOf(doc: Document, x: number, y: number, ids: NodeIds): { node: number; fx: number; fy: number } | null {
  for (let m = doc.elementFromPoint(x, y); m; m = m.parentElement) {
    const id = ids.getId(m);
    if (id < 0) continue;
    const r = m.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return { node: id, fx: 0.5, fy: 0.5 };
    return { node: id, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
  }
  return null;
}

type LayoutEvent = {
  type: number;
  data?: { source?: number; id?: number; anchor?: ScrollAnchor; anchored?: number; node?: { id?: number } };
};

/**
 * An event as the replayer gets it in a mirror laid out on its own. A scroll
 * that names its place is kept from the replayer, which would put the Mac's
 * pixels here, and the plugin below puts it at that place instead; a snapshot
 * starts at the top for the same reason. Untouched when there is no place.
 */
export function forOwnLayout<E extends LayoutEvent>(event: E): E {
  const d = event.data;
  if (!d?.anchor) return event;
  if (event.type === INCREMENTAL_SNAPSHOT && d.source === SCROLL_SOURCE) return { ...event, data: { ...d, id: -1, anchored: d.id } };
  if (event.type === FULL_SNAPSHOT) return { ...event, data: { ...d, anchored: d.node?.id, initialOffset: { top: 0, left: 0 } } };
  return event;
}

/**
 * The replayer plugin that scrolls the mirror to a place `forOwnLayout` kept
 * from the replayer. It runs right after the event is applied, so the element
 * a place names is in the mirror already. A snapshot lands at once; a scroll
 * glides there, as the replayer's own scrolls do in live mode.
 */
export function anchorPlacer(): {
  handler: (event: LayoutEvent, isSync: boolean, context: { replayer: { getMirror(): NodeIds } }) => void;
} {
  return {
    handler(event, isSync, { replayer }) {
      const d = event.data;
      if (!d?.anchor || typeof d.anchored !== 'number') return;
      const ids = replayer.getMirror();
      const node = ids.getNode(d.anchored);
      const place = node && placeOf(node, d.anchor, ids);
      if (!place) return;
      const behavior = isSync || event.type === FULL_SNAPSHOT ? 'instant' : 'smooth';
      try {
        place.el.scrollTo({ top: place.top, left: place.left, behavior: behavior as ScrollBehavior });
      } catch {
        place.el.scrollTop = place.top;
        place.el.scrollLeft = place.left;
      }
    },
  };
}
