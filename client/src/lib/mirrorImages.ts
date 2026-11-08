/**
 * The DOM mirror's lazy images load as they near the view, as on the source
 * (BROWSER-DOM-LAZY-01).
 *
 * The mirror is a sandboxed document without scripts, and HTML turns lazy
 * loading off where scripting is off: every viewer fetched all of a page's lazy
 * images at once (Darkroom on 13/10: 1049 of its 1056 images lazy, 568 requests
 * from the iPad through the Mac in one minute). So a lazy image reaches the
 * mirror without its sources, and the viewer, which does run scripts, gives
 * them back when it comes near the view. Images not marked lazy load as before,
 * and so do those in a nested frame, which the viewer does not watch.
 */
const DEFERRED_SRC = 'data-topics-src';
const DEFERRED_SOURCE_SET = 'data-topics-srcset';

/** The mirror's images still waiting for the view. */
export const DEFERRED_IMAGES = `img[${DEFERRED_SRC}], img[${DEFERRED_SOURCE_SET}]`;

interface SnapshotNode {
  type?: number;
  id?: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SnapshotNode[];
}

interface SnapshotData {
  node?: SnapshotNode;
  source?: number;
  adds?: { parentId?: number; node?: SnapshotNode }[];
  attributes?: { id: number; attributes: Record<string, unknown> }[];
}

/** rrweb's serialized node and event types. */
const ELEMENT_NODE = 2;
const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;
const MUTATION = 0;

/** Moves `src` and `srcset` aside; true when there was one to move. */
function setAside(attributes: Record<string, unknown>): boolean {
  let moved = false;
  for (const [name, aside] of [['src', DEFERRED_SRC], ['srcset', DEFERRED_SOURCE_SET]] as const) {
    if (name in attributes) {
      attributes[aside] = attributes[name];
      delete attributes[name];
      moved = true;
    }
  }
  return moved;
}

/**
 * Rewrites rrweb events in place before the replayer sees them, remembering
 * which images wait. A source that changes the `src` of a waiting image keeps
 * it waiting; one that changes an image already revealed is applied as is.
 */
export function createImageDeferral() {
  const waiting = new Set<number>();
  /** Iframes, and the nodes of the documents inside them. */
  const framed = new Set<number>();
  const visit = (node: SnapshotNode | undefined, inFrame: boolean): void => {
    if (!node) return;
    const element = node.type === ELEMENT_NODE;
    if (!inFrame && element && node.tagName === 'img' && node.attributes
      && String(node.attributes.loading).toLowerCase() === 'lazy'
      && setAside(node.attributes) && typeof node.id === 'number') {
      waiting.add(node.id);
    }
    const intoFrame = inFrame || (element && node.tagName === 'iframe');
    if (intoFrame && typeof node.id === 'number') framed.add(node.id);
    for (const child of node.childNodes ?? []) visit(child, intoFrame);
  };
  return {
    onEvent(event: { type?: number; data?: unknown }): void {
      const data = event.data as SnapshotData | undefined;
      if (!data) return;
      if (event.type === FULL_SNAPSHOT) {
        waiting.clear();
        framed.clear();
        visit(data.node, false);
      } else if (event.type === INCREMENTAL_SNAPSHOT && data.source === MUTATION) {
        // rrweb adds nodes one by one, and a nested document under its iframe.
        for (const add of data.adds ?? []) visit(add.node, add.parentId !== undefined && framed.has(add.parentId));
        for (const change of data.attributes ?? []) {
          if (waiting.has(change.id)) setAside(change.attributes);
        }
      }
    },
    /** The image with this id came into view: from now on its sources apply. */
    revealed(id: number): void {
      waiting.delete(id);
    },
  };
}

/** Gives a waiting image its sources back. */
export function revealImage(img: Element): void {
  const sourceSet = img.getAttribute(DEFERRED_SOURCE_SET);
  const src = img.getAttribute(DEFERRED_SRC);
  if (sourceSet !== null) {
    img.setAttribute('srcset', sourceSet);
    img.removeAttribute(DEFERRED_SOURCE_SET);
  }
  if (src !== null) {
    img.setAttribute('src', src);
    img.removeAttribute(DEFERRED_SRC);
  }
}

/**
 * Watch the mirror's document and reveal each waiting image as it comes within
 * `margin` of the view, the ones the source adds later included. The mirror's
 * document runs no scripts, so this one watches it. Returns the stop.
 */
export function watchDeferredImages(
  doc: Document,
  ids: { getId(node: Node): number },
  deferral: ReturnType<typeof createImageDeferral>,
  margin: string,
): () => void {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.unobserve(entry.target);
      revealImage(entry.target);
      deferral.revealed(ids.getId(entry.target));
    }
  }, { root: doc, rootMargin: margin });
  const observeWithin = (root: ParentNode) => root.querySelectorAll(DEFERRED_IMAGES).forEach((img) => io.observe(img));
  observeWithin(doc);
  const mo = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        // nodeType, not instanceof: the mirror's nodes belong to the iframe's realm.
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (el.matches(DEFERRED_IMAGES)) io.observe(el);
        else observeWithin(el);
      }
    }
  });
  mo.observe(doc, { childList: true, subtree: true });
  return () => {
    io.disconnect();
    mo.disconnect();
  };
}

/** Whether this engine observes intersections against a document, which the deferral needs. */
export function canObserveDocument(): boolean {
  try {
    new IntersectionObserver(() => {}, { root: document }).disconnect();
    return true;
  } catch {
    return false;
  }
}
