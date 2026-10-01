/**
 * exitGhost: the EXIT of a floating surface (menu, popover, context menu,
 * dialog), shared by every one of them.
 *
 * WHY A COPY AND NOT A DELAYED UNMOUNT. The obvious exit keeps the surface
 * mounted for the length of the animation. Here that would change behaviour in
 * three places at once: a closed menu would still be in the DOM for focus,
 * hit-testing and `getByRole` for 90ms; its call site would have to keep
 * rendering the content it has just dropped (half the menus render
 * `{target && …}` inside, so they would shrink to an empty card mid-fade); and
 * the many call sites that unmount the whole component (`{ctx && <Menu …>}`)
 * would get no exit at all. So the surface closes exactly as before, in the
 * same commit, and what fades is a DOM copy of its last frame: inert,
 * aria-hidden, with no ids or test ids, never hit by the pointer (index.css,
 * `[data-exit-ghost]`), and gone when its animation ends.
 *
 * No copy at all under reduced motion or while the window is backgrounded
 * (`.anims-paused`): there the surface simply disappears, as it always did.
 */
import { useLayoutEffect, type RefObject } from 'react';
import { MOTION } from './motion';
import { prefersReducedMotion } from './reducedMotion';

/**
 * `popover`: 90ms opacity + scale. `modal`: 150ms veil fade + the panel's own exit.
 * `sheet`: the phone's bottom sheet slides back down in 150ms; its scrim leaves
 * as a `modal` copy next to it.
 */
export type ExitKind = 'popover' | 'modal' | 'sheet';

/** Exit length per kind. Must match `[data-exit-ghost]` in index.css. */
export const EXIT_MS: Record<ExitKind, number> = {
  popover: MOTION.instant,
  modal: MOTION.fast,
  sheet: MOTION.fast,
};

/**
 * Copy `src` deep, with every `<video>`/`<audio>` replaced by a still: a canvas
 * with its classes, holding the frame it was on (blank and 300x150, like a
 * video with no metadata, when there is none). A cross-origin frame only
 * taints the canvas: it is still drawn.
 *
 * NOT `cloneNode(true)` FOR MEDIA: a cloned media element is a NEW one, not a
 * picture of the old. It starts with no frame (readyState 0), fetches its
 * source again even while detached and, with `autoPlay`, starts it from 0 with
 * its sound until the copy is removed. The board's lightbox closed that way:
 * the frame being watched vanished in one frame and the clip restarted aloud.
 * Swapping the clone afterwards is too late, the fetch has already started, so
 * a media element is never cloned at all.
 *
 * `pairs` maps every node of `src` to its copy, so the scroll offsets land on
 * the right element whatever the swap changed.
 */
function copyWithStills(src: Node, pairs: Map<Node, Node>): Node {
  let out: Node;
  if (src instanceof HTMLMediaElement) {
    const still = document.createElement('canvas');
    still.className = src.className;
    if (src instanceof HTMLVideoElement && src.readyState > 1) {
      still.width = src.videoWidth;
      still.height = src.videoHeight;
      still.getContext('2d')?.drawImage(src, 0, 0);
    }
    out = still;
  } else {
    out = src.cloneNode(false);
    for (const child of src.childNodes) out.appendChild(copyWithStills(child, pairs));
  }
  pairs.set(src, out);
  return out;
}

/**
 * Put a fading copy of `node` (already removed by React) back into `parent`.
 * `scrolled` restores the scroll offsets the copy would otherwise lose: a
 * detached element has no layout, so its `scrollTop` reads 0 and a scrolled
 * list would jump to its top while fading.
 */
export function playExitGhost(
  node: HTMLElement,
  parent: Node,
  kind: ExitKind,
  scrolled: ReadonlyMap<Element, number> = new Map(),
): HTMLElement | null {
  if (prefersReducedMotion()) return null;
  if (document.documentElement.classList.contains('anims-paused')) return null;
  const pairs = new Map<Node, Node>();
  const ghost = copyWithStills(node, pairs) as HTMLElement;
  for (const el of [ghost, ...ghost.querySelectorAll('[id], [data-testid]')]) {
    el.removeAttribute('id');
    el.removeAttribute('data-testid');
  }
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.dataset.exitGhost = kind;
  parent.appendChild(ghost);
  for (const [el, top] of scrolled) {
    const copy = pairs.get(el);
    if (copy instanceof Element) copy.scrollTop = top;
  }
  window.setTimeout(() => ghost.remove(), EXIT_MS[kind]);
  return ghost;
}

/**
 * Give the surface behind `ref` an exit. Call it next to the `open` that
 * mounts it; the surface keeps closing exactly as before.
 *
 * The copy is made after the commit (a microtask), and only if React really
 * removed the node: StrictMode's rehearsal unmount runs this cleanup too, but
 * leaves the node in the document, so nothing plays.
 */
export function useExitGhost(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  kind: ExitKind = 'popover',
): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const parent = node.parentNode;
    const scrolled = new Map<Element, number>();
    const onScroll = (e: Event) => {
      if (e.target instanceof Element) scrolled.set(e.target, e.target.scrollTop);
    };
    node.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      node.removeEventListener('scroll', onScroll, { capture: true });
      queueMicrotask(() => {
        if (node.isConnected || !parent?.isConnected) return;
        playExitGhost(node, parent, kind, scrolled);
      });
    };
  }, [open, ref, kind]);
}
