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

/** `popover`: 90ms opacity + scale. `modal`: 150ms veil fade + the panel's own exit. */
export type ExitKind = 'popover' | 'modal';

/** Exit length per kind. Must match `[data-exit-ghost]` in index.css. */
export const EXIT_MS: Record<ExitKind, number> = {
  popover: MOTION.instant,
  modal: MOTION.fast,
};

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
  const ghost = node.cloneNode(true) as HTMLElement;
  for (const el of [ghost, ...ghost.querySelectorAll('[id], [data-testid]')]) {
    el.removeAttribute('id');
    el.removeAttribute('data-testid');
  }
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.dataset.exitGhost = kind;
  parent.appendChild(ghost);
  if (scrolled.size > 0) {
    const from = [node, ...node.querySelectorAll('*')];
    const to = [ghost, ...ghost.querySelectorAll('*')];
    for (const [el, top] of scrolled) {
      const i = from.indexOf(el);
      if (i >= 0) to[i].scrollTop = top;
    }
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
